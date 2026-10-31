'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { developmentDataEnvironment } = require('./dev-data');

function randomSecret(existing, fallbackLength = 32) {
    return existing || crypto.randomBytes(fallbackLength).toString('hex');
}

function databaseURL(env, useInfrastructure) {
    // The disposable development PostgreSQL profile is reached from host
    // processes, so Docker-only hostnames from a Desktop-generated .env cannot
    // be reused here.
    if (useInfrastructure) {
        const username = env.BOX_POSTGRES_USER || 'box';
        const password = env.BOX_POSTGRES_PASSWORD || 'local-box-change-me';
        const database = env.BOX_POSTGRES_DB || 'box';
        const port = env.BOX_POSTGRES_HOST_PORT || '5432';
        return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
    }
    if (env.BOX_DATABASE_URL) {
        return env.BOX_DATABASE_URL;
    }
    const password = env.BOX_POSTGRES_PASSWORD || 'local-box-change-me';
    return `postgresql://box:${encodeURIComponent(password)}@127.0.0.1:5432/box`;
}

/**
 * Build the common environment used by every source-development service.
 *
 * Keeping this in one place is important: Creator, Play and Player Service
 * must all load the bundled local configuration. If one service omits
 * BOX_LOCAL_CONFIG_PATH, @box/env falls back to the legacy Nacos branch.
 */
function createDevelopmentEnvironment({ repoRoot, inheritedEnv, useInfrastructure }) {
    return {
        ...inheritedEnv,
        ...developmentDataEnvironment(repoRoot, inheritedEnv),
        NODE_ENV: 'development',
        BOX_LOCAL_CONFIG_PATH: path.join(repoRoot, 'apps/local-engine/config/local.config.json'),
        PERMISSION_TOKEN_SECRET: randomSecret(inheritedEnv.PERMISSION_TOKEN_SECRET),
        BOX_TELEPORT_INTERNAL_TOKEN: randomSecret(inheritedEnv.BOX_TELEPORT_INTERNAL_TOKEN),
        BOX_PLAYER_AUTH_API_KEY: randomSecret(inheritedEnv.BOX_PLAYER_AUTH_API_KEY, 16),
        BOX_DATABASE_URL: databaseURL(inheritedEnv, useInfrastructure),
        BOX_DATABASE_SCHEMA: inheritedEnv.BOX_DATABASE_SCHEMA || 'box_engine',
        BOX_IDENTITY_DATABASE_SCHEMA: inheritedEnv.BOX_IDENTITY_DATABASE_SCHEMA || 'box_identity',
        BOX_PLAYER_SERVICE_INTERNAL_URL: inheritedEnv.BOX_PLAYER_SERVICE_INTERNAL_URL || 'http://127.0.0.1:3124',
        BOX_PLAYER_SERVICE_PUBLIC_URL: inheritedEnv.BOX_PLAYER_SERVICE_PUBLIC_URL || 'http://127.0.0.1:3124',
        BOX_CREATOR_PUBLIC_URL: inheritedEnv.BOX_CREATOR_PUBLIC_URL || 'http://127.0.0.1:3127',
        BOX_PLAY_PUBLIC_URL: inheritedEnv.BOX_PLAY_PUBLIC_URL || 'http://127.0.0.1:3121',
        BOX_VOXA_PUBLIC_URL: inheritedEnv.BOX_VOXA_PUBLIC_URL || 'http://127.0.0.1:3123',
        BOX_VOXA_ALLOWED_ORIGINS: inheritedEnv.BOX_VOXA_ALLOWED_ORIGINS || 'http://127.0.0.1:3123,http://127.0.0.1:3127',
        VOXA_INTERNAL_URL: inheritedEnv.VOXA_INTERNAL_URL || 'http://127.0.0.1:3123',
        VOXA_URL: inheritedEnv.VOXA_URL || 'http://127.0.0.1:3123',
        BOX_PLAYER_LOGIN_URL: inheritedEnv.BOX_PLAYER_LOGIN_URL || 'http://127.0.0.1:3125',
        BOX_PLAYER_AUTH_ALLOWED_ORIGINS: inheritedEnv.BOX_PLAYER_AUTH_ALLOWED_ORIGINS || 'http://127.0.0.1:3125',
        BOX_AUTH_PORTAL_PUBLIC_URL: inheritedEnv.BOX_AUTH_PORTAL_PUBLIC_URL || 'http://127.0.0.1:3125',
        BOX_RESOURCE_ALLOWED_ORIGINS: inheritedEnv.BOX_RESOURCE_ALLOWED_ORIGINS || 'http://127.0.0.1:3123,http://127.0.0.1:3127',
    };
}

module.exports = { createDevelopmentEnvironment };
