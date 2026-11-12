import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isActionableDevelopmentRequest } from "../extensions/intent.ts";
import { readSettings, settingsPath } from "../extensions/settings.ts";
import devWorkflow from "../extensions/dev-workflow.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-dev-workflow-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "user-agent");
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await fs.rm(tmp, { recursive: true, force: true });
});

function fixture(name='repo') {
  const cwd = path.join(tmp, name + '-' + Math.random().toString(36).slice(2));
  const commands = {};
  const events = {};
  const tools = {};
  const sent = [];
  const notices = [];
  const status = [];
  let trusted = true;
  let selected;
  const sessionId = 'session-1';
  const api = {
    registerCommand: (name, spec) => { commands[name] = spec; },
    on: (name, fn) => { events[name] = fn; },
    registerTool: (spec) => { tools[spec.name] = spec; },
    sendUserMessage: (message, options) => { sent.push({ message, options }); },
    exec: async () => ({ code: 0, stdout: 'ok', stderr: '', killed: false, truncated: false }),
  };
  devWorkflow(api);
  const ctx = {
    cwd, hasUI: true, mode: 'tui',
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      setStatus: (name, value) => status.push({ name, value }),
      select: async () => selected,
    },
  };
  const state = () => fs.readFile(path.join(cwd, '.pi/dev-workflow/state.json'), 'utf8').then(JSON.parse);
  return { commands, events, tools, sent, notices, status, ctx, state,
    setTrusted: (v) => { trusted = v; }, setSelected: (v) => { selected = v; } };
}

const toolCall = (fixture, args) => fixture.tools.dev_workflow_report.execute('call', args, new AbortController().signal, () => {}, fixture.ctx);

test('intent gate is strict about actionable code requests and leaves questions alone', () => {
  const yes = [
    '帮我修复按钮点击失败的问题', '实现 PR #123 的需求', '重构订阅解析器的代码',
    'Add tests for the React component', 'Please fix the login bug',
    '为表单添加必填校验', '做一个 React 登录页面', '把当前按钮改为禁用状态', '修一下这个 API 的错误',
  ];
  const no = [
    '如何修复按钮点击失败？', '解释一下 React 19 的新特性',
    '请给我介绍一下这个项目', '今天天气怎么样',
    '/develop 修复按钮', '/skill:dev-workflow 修改代码',
    '请帮我写一篇文章', 'Can you explain how the login works?',
  ];
  for (const txt of yes) assert.equal(isActionableDevelopmentRequest(txt), true, 'Should detect '+txt);
  for (const txt of no) assert.equal(isActionableDevelopmentRequest(txt), false, 'Should skip '+txt);
});

test('install defaults to manual and does not intercept inputs', async () => {
  const f = fixture();
  await f.events.session_start({}, f.ctx);
  assert.equal((await readSettings()).autoStart, false);
  assert.equal((await f.events.input({ text:'修复按钮异常', source:'interactive' }, f.ctx)).action, 'continue');
  assert.equal(f.sent.length, 0);
  assert.equal(f.status.length, 0);
});

test('settings on/off persist, UI and status work', async () => {
  const f = fixture();
  f.setSelected('Auto: detect actionable development requests');
  await f.commands['develop-settings'].handler('', f.ctx);
  assert.equal((await readSettings()).autoStart, true);
  assert.ok((await fs.readFile(settingsPath(), 'utf8')).includes('"autoStart": true'));
  await f.commands['develop-settings'].handler('status', f.ctx);
  assert.ok(f.notices.some(n => n.message.includes('Auto start: ON')));
  await f.commands['develop-settings'].handler('auto off', f.ctx);
  assert.equal((await readSettings()).autoStart, false);
});

test('auto mode handles actionable prompt, delegates mode selection, avoids duplicate starts', async () => {
  const f = fixture();
  await f.commands['develop-settings'].handler('auto on', f.ctx);
  assert.equal((await f.events.input({ text:'如何修复按钮 bug？', source:'interactive' }, f.ctx)).action, 'continue');
  assert.equal((await f.events.input({ text:'修复按钮 bug', source:'extension' }, f.ctx)).action, 'continue');
  assert.equal((await f.events.input({ text:'修复按钮 bug', source:'interactive', streamingBehavior:'followUp' }, f.ctx)).action, 'continue');
  const intercepted = await f.events.input({ text:'修复按钮 bug', source:'interactive' }, f.ctx);
  assert.equal(intercepted.action, 'transform');
  assert.ok(intercepted.text.startsWith('/skill:dev-workflow 修复按钮 bug'));
  const state = await f.state();
  assert.equal(state.mode, 'auto');
  assert.equal(state.iteration, 1);
  assert.equal(state.sessionId, 'session-1');
  const second = await f.events.input({ text:'新增表单校验功能', source:'interactive' }, f.ctx);
  assert.equal(second.action, 'continue');
  assert.equal((await f.state()).task, '修复按钮 bug');
  const premature = await toolCall(f, {kind:'complete', summary:'Done'});
  assert.ok(premature.content[0].text.includes('Select FAST or STANDARD'));
  await toolCall(f, {kind:'mode', mode:'fast', summary:'Single component change'});
  assert.equal((await f.state()).mode, 'fast');
  assert.equal((await f.state()).maxIterations, 4);
  const next = await f.events.agent_before_settle({ entries: [] }, f.ctx);
  assert.equal(next.continue, true);
  assert.equal((await f.state()).iteration, 2);
});

test('STANDARD plan review blocks continuation until explicit approval', async () => {
  const f = fixture();
  await f.commands.develop.handler('--standard 根据 PR #123 完成开发', f.ctx);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.state()).mode, 'standard');
  await toolCall(f, {kind:'mode',mode:'standard',summary:'Breaking API change'});
  const planPath='docs/plans/pr-123.md';
  await fs.mkdir(path.join(f.ctx.cwd,'docs/plans'), { recursive:true });
  await fs.writeFile(path.join(f.ctx.cwd,planPath),'# Plan');
  await toolCall(f, {kind:'plan-ready',planPath,summary:'Ready for review'});
  assert.equal((await f.state()).phase, 'plan_review');
  assert.equal(await f.events.agent_before_settle({ entries: [] }, f.ctx), undefined);
  await f.commands['develop-approve'].handler('', f.ctx);
  assert.equal((await f.state()).phase,'running');
  assert.equal(f.sent.length, 2);
});

test('disabled auto still supports forced manual FAST; stop and resume', async () => {
  const f=fixture();
  await f.commands['develop-settings'].handler('auto off', f.ctx);
  assert.equal((await f.events.input({ text:'修复按钮 Bug', source:'interactive' }, f.ctx)).action,'continue');
  await f.commands.develop.handler('--fast Fix login bug',f.ctx);
  assert.equal((await f.state()).mode,'fast');
  await f.commands['develop-stop'].handler('', f.ctx);
  assert.equal((await f.state()).phase,'stopped');
  await f.commands['develop-resume'].handler('', f.ctx);
  assert.equal((await f.state()).phase,'running');
});

test('untrusted project cannot auto-start', async () => {
  const f=fixture();
  await f.commands['develop-settings'].handler('auto on',f.ctx);
  f.setTrusted(false);
  assert.equal((await f.events.input({text:'修复页面 bug',source:'interactive'},f.ctx)).action,'continue');
  assert.equal(f.status.filter(s=>s.value?.startsWith('DEV auto')).length,0);
});

test('completed without validators pauses for review instead of claiming success', async () => {
  const f=fixture();
  await f.commands.develop.handler('--fast Fix login bug',f.ctx);
  const answer=await toolCall(f,{kind:'complete',summary:'Manually tested'});
  assert.equal((await f.state()).phase,'review_required');
  assert.ok(answer.content[0].text.includes('review_required'));
  assert.equal(await f.events.agent_before_settle({entries:[]},f.ctx),undefined);
});

test('trusted configured independent validator completes', async () => {
  const f=fixture();
  await f.commands.develop.handler('--fast Fix login bug',f.ctx);
  await fs.mkdir(path.join(f.ctx.cwd,'.pi'),{recursive:true});
  await fs.writeFile(path.join(f.ctx.cwd,'.pi/dev-workflow.config.json'),JSON.stringify({validators:['node -v']}));
  const answer=await toolCall(f,{kind:'complete',summary:'All tests passed'});
  assert.equal((await f.state()).phase,'completed');
  assert.ok(answer.content[0].text.includes('validators passed'));
});

test('malformed user settings fail closed (manual), no auto prompt transformation', async () => {
  const f=fixture();
  await fs.writeFile(settingsPath(), '{not valid json');
  assert.equal((await readSettings()).autoStart,false);
  assert.equal((await f.events.input({text:'修复按钮 bug',source:'interactive'},f.ctx)).action,'continue');
});

test('auto setting OFF does not cancel an already active run', async () => {
  const f=fixture();
  await f.commands['develop-settings'].handler('auto on',f.ctx);
  await f.events.input({text:'修复按钮 bug',source:'interactive'},f.ctx);
  await f.commands['develop-settings'].handler('auto off',f.ctx);
  assert.equal((await f.state()).phase,'running');
  await toolCall(f,{kind:'mode',mode:'fast',summary:'One-component fix'});
  assert.equal((await f.state()).mode,'fast');
  const continued=await f.events.agent_before_settle({entries:[]},f.ctx);
  assert.equal(continued.continue,true);
});

test('global mode is re-enabled only when explicitly changed; active plan is not overwritten', async () => {
  const f=fixture();
  await f.commands['develop-settings'].handler('auto on',f.ctx);
  await f.commands.develop.handler('--standard 实现 PR #123',f.ctx);
  const state=await f.state();
  const result=await f.events.input({text:'修复按钮 bug',source:'interactive'},f.ctx);
  assert.equal(result.action,'continue');
  assert.deepEqual(await f.state(),state);
});
