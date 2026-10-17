'use strict';

const target = process.env.BOX_LOCAL_WEB_URL || 'http://127.0.0.1:3002';

function assertAuthenticationGuard(status, body) {
    if (status === 503 && body?.code === 'LOGIN_URL_NOT_CONFIGURED') {
        return 'login URL not configured';
    }

    if (status === 401 && body?.code === 'AUTH_REQUIRED') {
        if (typeof body.loginUrl !== 'string' || !body.loginUrl) {
            throw new Error('AUTH_REQUIRED response must include loginUrl');
        }
        let loginUrl;
        try {
            loginUrl = new URL(body.loginUrl);
        } catch {
            throw new Error('AUTH_REQUIRED response contains an invalid loginUrl');
        }
        if (!['http:', 'https:'].includes(loginUrl.protocol)) {
            throw new Error('AUTH_REQUIRED loginUrl must use HTTP or HTTPS');
        }
        return 'external login URL configured';
    }

    throw new Error(
        `unauthenticated edit session was not blocked correctly: received ${status} ${body?.code || ''}`,
    );
}

async function main() {
    const response = await fetch(`${target}/api/createSession`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'origin': target,
            'referer': `${target}/e/local`,
        },
        body: JSON.stringify({
            mode: 'edit',
            contentId: 0,
            containerName: 'authentication-check',
            fingerPrint: 'local-edit-session-check',
            serverId: '',
        }),
    });

    const body = await response.json();
    const mode = assertAuthenticationGuard(response.status, body);
    console.log(`Edit session authentication guard check passed (${mode})`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { assertAuthenticationGuard };
