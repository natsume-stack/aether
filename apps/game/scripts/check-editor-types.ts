import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(__dirname, '../../..');
const editorTypes = fs.readFileSync(path.join(root, 'apps/game/src/resource/api-declarations.dts'), 'utf8');
const sdkTypes = fs.readFileSync(path.join(root, 'packages/script-api/dts/server-api-types.dts'), 'utf8');
const standaloneTypes = fs.readFileSync(path.join(root, 'packages/script-api/dts/box3-server-api.d.ts'), 'utf8');

/** Exercise the same TypeScript language service that powers Monaco, not a text search. */
class ScriptTypeProbe {
  private source = '';
  private version = 0;
  private script = path.join(root, '__script_type_probe__.js');
  private files: Record<string, string>;
  private service: ts.LanguageService;
  constructor(declarations: Record<string, string>) {
    this.files = Object.fromEntries(Object.entries(declarations).map(([name, value]) => [path.join(root, name), value]));
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2020, allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true };
    this.service = ts.createLanguageService({
      getCompilationSettings: () => options,
      getScriptFileNames: () => [this.script, ...Object.keys(this.files)],
      getScriptVersion: file => file === this.script ? String(this.version) : '1',
      getScriptSnapshot: file => {
        const text = file === this.script ? this.source : this.files[file] ?? ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: file => file === this.script || file in this.files || ts.sys.fileExists(file),
      readFile: file => this.files[file] ?? ts.sys.readFile(file),
      readDirectory: ts.sys.readDirectory,
    });
  }
  completions(code: string) {
    this.setSource(code);
    return this.service.getCompletionsAtPosition(this.script, code.length, {})?.entries.map(entry => entry.name) || [];
  }
  signature(code: string) {
    this.setSource(code);
    return this.service.getSignatureHelpItems(this.script, code.length, undefined);
  }
  diagnostics(code: string) {
    this.setSource(code);
    return this.service.getSemanticDiagnostics(this.script);
  }
  hover(code:string) {
    this.setSource(code);
    return this.service.getQuickInfoAtPosition(this.script,code.length-1);
  }
  private setSource(code: string) { this.source = code; this.version++; }
  dispose() { this.service.dispose(); }
}

// Check the editor's exact library order and the standalone downloadable SDK.
for (const [name, declarations] of [
  ['editor', { 'api.d.ts': editorTypes, 'server-api.d.ts': sdkTypes }],
  ['standalone SDK', { 'box3-server-api.d.ts': standaloneTypes }],
] as const) {
  const probe = new ScriptTypeProbe(declarations);
  try {
    const anticheat = probe.completions('world.anticheat.');
    for (const method of ['createTracker', 'onMovement', 'onMessage', 'onInput', 'onAction', 'onKeyboard', 'onInteract', 'onCustomEvent', 'onUIEvent']) assert.ok(anticheat.includes(method), `${name}: missing anticheat ${method}`);
    assert.equal(probe.diagnostics('const tracker = world.anticheat.createTracker({historySize:32,decayPerTick:0}); world.anticheat.onMovement(({player,to,context}) => { tracker.record(player,{x:to.x}); tracker.addScore(player,1); console.log(tracker.getHistory(player),tracker.getScore(player),tracker.serverTick); tracker.exempt(player,{ticks:10,reason:"server skill"}); if(!tracker.isExempt(player)) context.reject(); tracker.clearExemption(player); tracker.resetScore(player); tracker.clear(player); });').length, 0, `${name}: tracker example has type errors`);
    assert.ok(probe.diagnostics('const tracker = world.anticheat.createTracker(); tracker.serverTick = 999;').length > 0, `${name}: tracker clock must be read-only`);
    assert.ok(probe.diagnostics('const tracker = world.anticheat.createTracker(); tracker.getHistory(world.querySelector("player").player).push({serverTick:999,data:null});').length > 0, `${name}: tracker history must be read-only`);
    assert.equal(probe.diagnostics('world.anticheat.onAction(({actions,serverPosition,context}) => { for (const action of actions) { if (action.pressed && action.ray.origin.x - serverPosition.x > 10) context.reject(); console.log(action.targetId,action.ray.voxel,action.button); } });').length, 0, `${name}: action example has type errors`);
    assert.ok(probe.diagnostics('world.anticheat.onAction(({actions}) => { actions[0].ray.origin.x = 99; });').length > 0, `${name}: action data must be read-only`);
    assert.equal(probe.diagnostics('world.anticheat.onInput(({buttons, context}) => { if(buttons.fly) context.reject(); }); world.anticheat.onKeyboard(({pressed,released}) => console.log(pressed,released)); world.anticheat.onInteract(({target}) => { if(target) console.log(target.id); }); world.anticheat.onCustomEvent(({data,context}) => { console.log(data); context.reject(); });').length, 0, `${name}: categorized anticheat examples have type errors`);
    assert.equal(probe.diagnostics('world.anticheat.onMovement(({player, from, to, elapsedMs, context}) => { console.log(player.name, from.x, to.y, elapsedMs, context.mode); context.reject(); }); world.anticheat.onMessage(({protocol, message, data, context}) => { console.log(protocol, message, data); context.reject(); });').length, 0, `${name}: anticheat examples have type errors`);
    assert.ok(probe.diagnostics('world.anticheat.onMovement(event => { event.to.x = 100; });').length > 0, `${name}: mutable movement data exposed`);
    const methods = probe.completions('world.moderation.');
    for (const method of ['banPlayer', 'banCurrentIP', 'banCurrentDevice', 'revokeBan', 'getPlayerStatus', 'listBans', 'getBan']) {
      assert.ok(methods.includes(method), `${name}: missing ${method} completion`);
    }
    assert.ok(!methods.includes('mapId'),`${name}: removed mapId still exposed`);
    const options = probe.completions('world.moderation.banPlayer(world.querySelector("player").player, { ');
    for (const field of ['reason', 'durationSeconds', 'requestId']) {
      assert.ok(options.includes(field), `${name}: missing ${field} completion`);
    }
    assert.ok(!options.includes('scope'), `${name}: removed scope still in completion`);
    const signature = probe.signature('world.moderation.banPlayer(');
    assert.equal(signature?.items.length,3,`${name}: duplicate signature hints`);
    assert.ok(signature?.items[0].parameters.some(parameter => parameter.name === 'options'));
    assert.ok(probe.hover('world.moderation.banPlayer')?.documentation?.some(part=>part.text.includes('封禁')));
    assert.equal(probe.diagnostics('world.moderation.banPlayer(world.querySelector("player").player, {reason:"test",durationSeconds:60,requestId:"test"});').length,0,`${name}: valid call has type errors`);
    assert.equal(probe.diagnostics('world.moderation.banCurrentDevice(world.querySelectorAll("player").map(entity => entity.player), {reason:"test",durationSeconds:0,requestId:"batch"}).then(results => results.forEach(result => { if (result.success === true) console.log(result.ban.id); else console.log(result.error); }));').length,0,`${name}: batch device call has type errors`);
    assert.equal(probe.diagnostics('world.moderation.listBans({player:world.querySelector("player").player,kind:"device",status:"expired",page:1,pageSize:20}).then(result => result.items.forEach(ban => console.log(ban.reason,ban.remainingSeconds))); world.moderation.getBan("00000000-0000-0000-0000-000000000000").then(ban => { if (ban) console.log(ban.status); });').length,0,`${name}: punishment queries have type errors`);
    for (const code of [
      'world.moderation.banPlayer(world.querySelector("player"), {reason:"test",durationSeconds:60,requestId:"entity"});',
      'world.moderation.banCurrentIP(world.querySelectorAll("player"), {reason:"test",durationSeconds:60,requestId:"entities"});',
      'world.moderation.getPlayerStatus(world.querySelector("player"));',
      'world.moderation.listBans({player:world.querySelector("player")});',
    ]) assert.ok(probe.diagnostics(code).length > 0, `${name}: entity accepted instead of GamePlayer`);
    assert.equal(probe.diagnostics('const player = world.querySelector("player").player; world.moderation.banPlayer(player, {reason:"test",durationSeconds:60}); world.moderation.banCurrentDevice([player], {reason:"test",durationSeconds:60}); world.moderation.revokeBan("ban", {reason:"review"});').length, 0, `${name}: omitted requestId has type errors`);
    assert.ok(probe.diagnostics('world.moderation.getBan("ban").then(ban => { if (ban) console.log(ban.scope); });').length > 0, `${name}: removed record scope still exposed`);
    const errors = probe.diagnostics('world.moderation.banPlayer(world.querySelector("player").player, {reason: "test", durationSeconds: 60, requestId: "test", scope: "server"});');
    assert.ok(errors.some(error => error.code === 2353 || error.code === 2322 || error.code === 2345 || error.code === 2769), `${name}: removed scope parameter was not rejected: ${JSON.stringify(errors.map(error=>({code:error.code,message:ts.flattenDiagnosticMessageText(error.messageText,' ')})))}`);
    assert.equal(probe.diagnostics('world.anticheat.onAction(event => { for (const action of event.actions) { if (action.target) console.log(action.target.position.x); } });').length, 0,
      `${name}: server-resolved action target has type errors`);
    assert.ok(probe.completions('world.anticheat.onAction(event => { const action = event.actions[0]; action.').includes('target'),
      `${name}: missing action target completion`);
    console.log(`${name}: moderation and server-resolved anticheat target types passed`);
  } finally { probe.dispose(); }
}

const clientProbe = new ScriptTypeProbe({
  'client-api.d.ts': fs.readFileSync(path.join(root, 'packages/script-api/dts/client-api-types.dts'), 'utf8'),
});
try {
  const clientWorld = clientProbe.completions('world.');
  assert.ok(clientWorld.includes('rendering3d'), 'probe must resolve the real ClientWorld, not an unknown identifier');
  assert.ok(!clientWorld.includes('anticheat'), 'client script must not expose GameAnticheat');
  assert.ok(clientProbe.diagnostics('world.anticheat.createTracker();').length > 0, 'client script must not accept tracker calls');
  console.log('client SDK: server anticheat and tracker APIs are unavailable');
} finally { clientProbe.dispose(); }
