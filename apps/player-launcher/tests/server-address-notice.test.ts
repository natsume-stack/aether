import assert from 'node:assert/strict';
import test from 'node:test';

import { getServerAddressNotice } from '../src/features/servers/address-notice';

test('keeps local HTTP addresses quiet', () => {
    assert.equal(getServerAddressNotice('127.0.0.1:3492'), null);
    assert.equal(getServerAddressNotice('http://localhost:3492'), null);
});

test('does not treat malformed numeric input as a public IP confirmation', () => {
    assert.equal(getServerAddressNotice('122111222'), null);
    assert.equal(getServerAddressNotice('256.1.1.1'), null);
});

test('warns before adding a public server over HTTP in player-friendly language', () => {
    const notice = getServerAddressNotice('http://play.example.com');
    assert.equal(notice?.title, '这个服务器连接不安全');
    assert.match(notice?.message || '', /账号和连接信息可能被.*看到/);
    assert.match(notice?.message || '', /地图素材也可能无法保存在本机/);
    assert.match(notice?.message || '', /安全连接（HTTPS）地址/);
});

test('allows non-loopback IP addresses while explaining what players should expect', () => {
    const notice = getServerAddressNotice('203.0.113.9:3492');
    assert.equal(notice?.title, '正在添加 IP 地址');
    assert.match(notice?.message || '', /IP 地址可以使用/);
    assert.match(notice?.message || '', /地图素材.*保存在本机/);
});

test('warns more clearly when the public IP also uses unencrypted HTTP', () => {
    const notice = getServerAddressNotice('http://203.0.113.9:3492');
    assert.equal(notice?.title, '这个 IP 地址的连接不安全');
    assert.match(notice?.message || '', /账号和连接信息可能被.*看到/);
});
