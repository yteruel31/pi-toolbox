import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runProcess } from '../src/process.js';
import { cloneRepository, cleanupRepository, isGitHubRepository } from '../src/github.js';
import { extractFrames, isYouTubeVideo } from '../src/video.js';

test('strict GitHub roots, not normalized paths or credential URLs', () => {
  for (const url of ['https://github.com/owner/repo', 'https://github.com/owner/repo.git/']) assert.equal(isGitHubRepository(url), true);
  for (const url of ['http://github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?x=1', 'https://user@github.com/a/b', 'https://github.com/a/x/../b', 'https://github.com/a/%62', 'https://github.com.evil/a/b']) assert.equal(isGitHubRepository(url), false);
});

test('canonical YouTube only; unsupported media fails before spawning', async () => {
  assert.equal(isYouTubeVideo('https://www.youtube.com/watch?v=abcdefghijk'), true);
  assert.equal(isYouTubeVideo('https://youtu.be/abcdefghijk'), true);
  assert.equal(isYouTubeVideo('https://youtu.be/abcdefghijk?list=123'), false);
  const options = { cwd: '/', cacheDir: '/nonexistent', timeoutMs: 1000 };
  await assert.rejects(extractFrames('https://evil.test/movie.mp4', options), /Only local/);
  await assert.rejects(extractFrames('playlist.m3u8', options), /Unsupported/);
  await assert.rejects(extractFrames('image.svg', options), /Unsupported/);
  await assert.rejects(extractFrames('movie.mp4', { ...options, frames: 13 }), /Frames/);
  await assert.rejects(extractFrames('movie.mp4', { ...options, timestamp: '00:60:00' }), /Timestamp/);
  await assert.rejects(extractFrames('movie.mp4', { ...options, timestamp: '00:00:05-00:00:01' }), /range/);
});

test('process runner bounds output, aborts, times out and redacts errors', async () => {
  const options = { timeoutMs: 3000 };
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({key:process.env.SECRET_TOKEN, path:process.env.PATH, arg:process.argv[1]}))', '$(echo unsafe)'], options);
  assert.deepEqual(JSON.parse(result.stdout), { path: '/usr/bin:/bin', arg: '$(echo unsafe)' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.error("private-token");process.exit(1)'], options), (error: Error) => !error.message.includes('private-token') && /exit 1/.test(error.message));
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(10000))'], { ...options, maxOutputBytes: 10 }), /output limit/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},100)'], { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
  // A parent that exits while its child holds stdout open must not leave that descendant alive.
  await runProcess(process.execPath, ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setTimeout(()=>process.exit(0),50)'], { timeoutMs: 1000 });
  await assert.rejects(runProcess('definitely-missing-web-access-executable', [], options), /not installed/);
  await assert.rejects(runProcess('git', [], { ...options, env: { GIT_CONFIG_COUNT: '1' } }), /Unsupported/);
});

test('offline media and clone mocks enforce command arguments and cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-test-'));
  const original = childProcess.spawn;
  const calls: Array<{ executable: string; args: string[]; options: childProcess.SpawnOptions }> = [];
  let failClone = false;
  childProcess.spawn = ((executable: string, args: string[], options: childProcess.SpawnOptions) => {
    calls.push({ executable, args, options });
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(async () => {
      try {
        if (executable === 'ffprobe') child.stdout.write(JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'video', width: 1920, height: 1080 }] }));
        else if (executable === 'ffmpeg') await writeFile(args.at(-1)!, Buffer.from([255, 216, 1, 255, 217]));
        else if (args.includes('clone')) {
          await mkdir(args.at(-1)!, { recursive: true });
          await writeFile(join(args.at(-1)!, 'README.md'), 'Example README');
          await symlink('/etc/passwd', join(args.at(-1)!, 'secret'));
          if (failClone) { child.stderr.write('secret credentials'); child.emit('close', 128); return; }
        } else if (args.includes('ls-tree')) child.stdout.write('100644 blob abc123 14\tREADME.md\0');
        child.emit('exit', 0);
        child.emit('close', 0);
      } catch (error) { child.emit('error', error); child.emit('close', 1); }
    });
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    await writeFile(join(root, 'clip.mp4'), 'fake video for process mock');
    await symlink(join(root, 'clip.mp4'), join(root, 'link.mp4'));
    await assert.rejects(extractFrames('link.mp4', { cwd: root, cacheDir: root, timeoutMs: 5000 }), /regular file/);
    await rm(join(root, 'link.mp4'));
    assert.equal(calls.length, 0);
    await assert.rejects(extractFrames('clip.mp4', { cwd: root, cacheDir: root, timeoutMs: 5000, timestamp: '00:00:11' }), /outside video/);
    assert.equal(calls.filter((call) => call.executable === 'ffmpeg').length, 0);
    calls.length = 0;
    const video = await extractFrames('clip.mp4', { cwd: root, cacheDir: root, timeoutMs: 5000, frames: 2 });
    assert.equal(video.images.length, 2);
    for (const call of calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.detached, true);
      assert.equal(call.args[call.args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
      assert.ok(call.args.includes('-format_whitelist'));
      assert.equal(call.options.env?.HTTP_PROXY, undefined);
    }
    assert.ok(calls.find((call) => call.executable === 'ffmpeg')?.args.some((arg) => arg.includes('1280')));
    assert.deepEqual(await readdir(root), ['clip.mp4']);
    calls.length = 0;
    const repo = await cloneRepository('https://github.com/example/repo', { cacheDir: root, timeoutMs: 5000, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    assert.match(repo.content, /Example README/);
    assert.doesNotMatch(repo.content, /"secret"/);
    for (const call of calls) {
      assert.equal(call.executable, 'git');
      assert.ok(call.args.includes('http.followRedirects=false'));
      assert.ok(call.args.includes('http.curloptResolve=github.com:443:8.8.8.8'));
      assert.ok(call.args.includes('credential.helper='));
      assert.ok(call.args.includes('core.hooksPath=/dev/null'));
      assert.equal(call.options.env?.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(call.options.env?.GIT_CONFIG_NOSYSTEM, '1');
    }
    assert.ok(calls[0]?.args.includes('--no-checkout'));
    assert.ok(calls[0]?.args.includes('--no-recurse-submodules'));
    await cleanupRepository(repo.path);
    await assert.rejects(cleanupRepository(root), /not owned/);
    failClone = true;
    await assert.rejects(cloneRepository('https://github.com/example/private', { cacheDir: root, timeoutMs: 5000, lookup: async () => [{ address: '8.8.8.8', family: 4 }] }), (error: Error) => /gh auth status/.test(error.message) && !/secret credentials/.test(error.message));
    assert.deepEqual(await readdir(root), ['clip.mp4']);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
