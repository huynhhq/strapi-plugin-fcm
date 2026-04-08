"use strict";

const admin = require("firebase-admin");

const INVALID_TOKEN_ERROR_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
]);

const parseTokens = (target = '') => String(target)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

const parseTopics = (target = '') => String(target)
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean)
    .map((topic) => topic.replace(/^\/?topics\//, ''));

const isTopicLikeTarget = (value = '') => /^(\/?topics\/)/.test(String(value).trim());

const getMessagingErrorCode = (error) =>
    error?.errorInfo?.code || error?.code || error?.details?.errorCode;

// Builds a normalised message object for the modern Firebase Admin SDK.
// - Conditionally includes `data` to avoid passing undefined to the SDK.
// - Forwards mutableContent via the apns key so iOS notifications can be mutated.
const buildMessage = (payload) => ({
    notification: payload.notification,
    ...(payload.data ? { data: payload.data } : {}),
    apns: { payload: { aps: { mutableContent: true } } },
});

const clearInvalidUserTokens = async (tokens = []) => {
    const uniqueTokens = [...new Set(tokens.filter(Boolean))];
    if (uniqueTokens.length === 0 || !global.strapi) {
        return;
    }

    try {
        const users = await global.strapi.query("plugin::users-permissions.user").findMany({
            where: { fcmToken: { $in: uniqueTokens } },
            select: ['id', 'fcmToken'],
        });

        if (!users?.length) {
            return;
        }

        await Promise.all(users.map((user) =>
            global.strapi.query("plugin::users-permissions.user").update({
                where: { id: user.id },
                data: { fcmToken: null },
            })
        ));

        console.warn('[FCM] Cleared invalid FCM token(s) from users:', uniqueTokens.length);
    } catch (cleanupError) {
        console.error('[FCM] Failed to clear invalid token(s):', cleanupError?.message || cleanupError);
    }
};

module.exports = {
    /*
    * Send a message to a device(s) or a topic.
    * @param {Object} entry - of type: see the attributes in schema ../server/content-types/fcm-notification/schema.json
    * @returns {Promise<any>}
    * */
    send: async (entry) => {
        try {
            // console.log('send to FCM', entry);
            let payload = {
                notification: {
                    title: entry.title
                }
            };
            if (entry.body) {
                payload.notification.body = entry.body;
            }
            if (entry.image) {
                payload.notification.imageUrl = entry.image;
            }

            if (entry.payload) {
                try {
                    let jsonPayload = JSON.parse(entry.payload);
                    payload = { ...payload, ...jsonPayload };
                } catch {
                    console.log("parsing failed so sending without payload")
                }
            }

            // console.log('payload', payload, 'target is ', entry.target);
            let res = null;
            if (entry.targetType === 'tokens') {
                const tokens = parseTokens(entry.target);
                if (tokens.length === 0) {
                    return { successCount: 0, failureCount: 0, skipped: true };
                }

                // Backward compatibility: some callsites incorrectly pass /topics/* with targetType=tokens.
                if (tokens.every(isTopicLikeTarget)) {
                    const topics = parseTopics(entry.target);
                    if (topics.length === 0) {
                        return { successCount: 0, failureCount: 0, skipped: true };
                    }

                    if (topics.length > 1) {
                        res = await admin.messaging().send({
                            condition: topics.map(t => `'${t}' in topics`).join(' || '),
                            ...buildMessage(payload),
                        });
                    } else {
                        res = await admin.messaging().send({
                            topic: topics[0],
                            ...buildMessage(payload),
                        });
                    }
                    return res;
                }

                if (tokens.length > 1) {
                    // res = await admin.messaging().sendMulticast({ tokens }, payload, options);
                    res = await admin.messaging().sendEachForMulticast({
                        tokens,
                        ...buildMessage(payload),
                    });

                    const invalidTokens = [];
                    (res?.responses || []).forEach((response, index) => {
                        const code = getMessagingErrorCode(response?.error);
                        if (!response?.success && INVALID_TOKEN_ERROR_CODES.has(code)) {
                            invalidTokens.push(tokens[index]);
                        }
                    });

                    if (invalidTokens.length > 0) {
                        await clearInvalidUserTokens(invalidTokens);
                    }
                } else {
                    // res = await admin.messaging().sendToDevice(entry.target, payload, options);
                    res = await admin.messaging().send({
                        token: tokens[0],
                        ...buildMessage(payload),
                    });
                }
            } else {
                const topics = parseTopics(entry.target);
                if (topics.length === 0) {
                    return { successCount: 0, failureCount: 0, skipped: true };
                }

                if (topics.length > 1) {
                    res = await admin.messaging().send({
                        condition: topics.map(t => `'${t}' in topics`).join(' || '),
                        ...buildMessage(payload),
                    });
                } else {
                    res = await admin.messaging().send({
                        topic: topics[0],
                        ...buildMessage(payload),
                    });
                }
            }
            // console.log('send to FCM res', JSON.stringify(res));
            return res;
        } catch (error) {
            const code = getMessagingErrorCode(error);
            if (entry?.targetType === 'tokens' && INVALID_TOKEN_ERROR_CODES.has(code)) {
                await clearInvalidUserTokens(parseTokens(entry?.target));
            }

            console.error('[FCM] send error:', error);
            console.error('[FCM] send error, targetType:', entry?.targetType, '| target: [REDACTED]');

            return {
                successCount: 0,
                failureCount: 1,
                errorCode: code || 'messaging/unknown-error',
            };
        }
    },
    /*
    * Initialize or reinitialize the firebase app
    * */
    initialize: async (strapi) => {
        const data = await strapi.db.query('plugin::strapi-plugin-fcm.fcm-plugin-configuration').findOne({
            select: ['serviceAccount']
        });
        // console.log('serviceAccount', serviceAccount);
        // console.log('admin.apps?.length', admin.apps?.length);
        if (data !== null && data.serviceAccount) {
            if (admin.apps?.length > 1) {
                Promise.all(admin.apps.map(app => app.delete())).then(() => {
                    admin.initializeApp({
                        credential: admin.credential.cert(data.serviceAccount)
                    });
                });
            } else {
                admin.initializeApp({
                    credential: admin.credential.cert(data.serviceAccount),
                });
            }
        }
    }
}
