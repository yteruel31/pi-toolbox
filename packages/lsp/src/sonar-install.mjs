#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import yauzl from "yauzl";

export const SONAR_RELEASE = "5.8.1+80613";
export const SONAR_VERSION = "5.8.1";
export const JGIT_VERSION = "7.0.0.202409031743-r";
export const JGIT_SHA256 = "cc9f5f5772fa6b952a907d76531eb08f1fd8a8830cf1a3573261d7dd955c014a";

const RELEASE_PATH = "5.8.1%2B80613";
const ASSETS = {
  "darwin-arm64": { name: "sonarlint-vscode-darwin-arm64-5.8.1.vsix", bytes: 251_041_245, sha256: "958b70221acf1c3cf7cc1c3c820f24c1b3b6f563c329008ee147633bc99e658b" },
  "darwin-x64": { name: "sonarlint-vscode-darwin-x64-5.8.1.vsix", bytes: 252_141_159, sha256: "b3f005115163dd27f7456a9e2adb5e210e35f4f09055c174483c52a686885e11" },
  "linux-x64": { name: "sonarlint-vscode-linux-x64-5.8.1.vsix", bytes: 254_812_279, sha256: "e898a3894bc8ec9575f35b18a51c481b4e13285e18239c62bd2e5604867f7422" },
  "win32-x64": { name: "sonarlint-vscode-win32-x64-5.8.1.vsix", bytes: 250_938_487, sha256: "dcc1d6e903180ad3cbb53a8c4965ff198cd5c3e7a4c719b1da61da42f51e56db" },
};

export function sonarDataDirectory(environment = process.env, home = os.homedir()) {
  const dataHome = environment.XDG_DATA_HOME || (process.platform === "win32" ? environment.LOCALAPPDATA : undefined);
  return path.join(dataHome || path.join(home, ".local", "share"), "pi-lsp", "sonarqube");
}

export function sonarRuntimeDirectory(platform = process.platform, architecture = process.arch, environment = process.env, home = os.homedir()) {
  return path.join(sonarDataDirectory(environment, home), SONAR_VERSION, `${platform}-${architecture}`, "extension");
}

export function sonarJgitPath(environment = process.env, home = os.homedir()) {
  return path.join(sonarDataDirectory(environment, home), "jgit", JGIT_VERSION, `org.eclipse.jgit-${JGIT_VERSION}.jar`);
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(url, destination, expectedBytes, expectedSha256) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "@yteruel31/pi-lsp" } });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength !== expectedBytes) throw new Error("Downloaded artifact size does not match the pinned release");
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > expectedBytes ? new Error("Downloaded artifact exceeds the pinned release size") : undefined, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { mode: 0o600 }));
  if (received !== expectedBytes) throw new Error("Downloaded artifact size does not match the pinned release");
  const actual = await sha256(destination);
  if (actual !== expectedSha256) throw new Error(`Downloaded artifact checksum mismatch: expected ${expectedSha256}, got ${actual}`);
}

export function safeDestination(root, entryName) {
  const normalized = entryName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Unsafe VSIX entry: ${entryName}`);
  const destination = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe VSIX entry: ${entryName}`);
  return destination;
}

export async function extractVsix(vsixPath, destination) {
  await new Promise((resolve, reject) => {
    yauzl.open(vsixPath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error("Unable to open VSIX"));
        return;
      }
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry) => {
        void (async () => {
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) throw new Error(`VSIX symlinks are not allowed: ${entry.fileName}`);
          const destinationPath = safeDestination(destination, entry.fileName);
          if (entry.fileName.endsWith("/")) {
            await mkdir(destinationPath, { recursive: true });
            zip.readEntry();
            return;
          }
          await mkdir(path.dirname(destinationPath), { recursive: true });
          const stream = await new Promise((streamResolve, streamReject) => {
            zip.openReadStream(entry, (error, readStream) => error || !readStream ? streamReject(error ?? new Error("Unable to read VSIX entry")) : streamResolve(readStream));
          });
          await pipeline(stream, createWriteStream(destinationPath, { mode: mode & 0o777 || 0o644 }));
          if (mode & 0o111) await chmod(destinationPath, mode & 0o777);
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}

async function verifyRuntime(runtimeDirectory) {
  const required = [
    path.join(runtimeDirectory, "server", "sonarlint-ls.jar"),
    path.join(runtimeDirectory, "analyzers", "sonarjs.jar"),
    path.join(runtimeDirectory, "eslint-bridge"),
    path.join(runtimeDirectory, "jre"),
  ];
  for (const candidate of required) await stat(candidate);
}

export async function installSonarRuntime({ platform = process.platform, architecture = process.arch, force = false } = {}) {
  const asset = ASSETS[`${platform}-${architecture}`];
  if (!asset) throw new Error(`No pinned SonarQube for IDE runtime is available for ${platform}-${architecture}`);
  const runtimeDirectory = sonarRuntimeDirectory(platform, architecture);
  const installationDirectory = path.dirname(runtimeDirectory);
  const installedJgitPath = sonarJgitPath();
  if (!force) {
    try {
      await verifyRuntime(runtimeDirectory);
      if (await sha256(installedJgitPath) !== JGIT_SHA256) throw new Error("JGit checksum mismatch");
      return { runtimeDirectory, jgitPath: installedJgitPath, alreadyInstalled: true };
    } catch {
      // Continue with a clean installation.
    }
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-sonar-install-"));
  const vsixPath = path.join(temporaryRoot, asset.name);
  const extracted = path.join(temporaryRoot, "extracted");
  const releaseUrl = `https://github.com/SonarSource/sonarlint-vscode/releases/download/${RELEASE_PATH}/${asset.name}`;
  const jgitPath = installedJgitPath;
  const temporaryJgit = path.join(temporaryRoot, path.basename(jgitPath));
  const jgitUrl = `https://repo1.maven.org/maven2/org/eclipse/jgit/org.eclipse.jgit/${JGIT_VERSION}/org.eclipse.jgit-${JGIT_VERSION}.jar`;

  try {
    await Promise.all([download(releaseUrl, vsixPath, asset.bytes, asset.sha256), download(jgitUrl, temporaryJgit, 3_222_342, JGIT_SHA256)]);
    await extractVsix(vsixPath, extracted);
    await verifyRuntime(path.join(extracted, "extension"));
    await rm(installationDirectory, { recursive: true, force: true });
    await mkdir(path.dirname(installationDirectory), { recursive: true });
    await rename(extracted, installationDirectory);
    await mkdir(path.dirname(jgitPath), { recursive: true });
    await rm(jgitPath, { force: true });
    await rename(temporaryJgit, jgitPath);
    return { runtimeDirectory, jgitPath, alreadyInstalled: false };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function main() {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--force");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  const result = await installSonarRuntime({ force: process.argv.includes("--force") });
  if (result.alreadyInstalled) {
    process.stdout.write(`SonarQube runtime ${SONAR_VERSION} is already installed at ${result.runtimeDirectory}\n`);
  } else {
    process.stdout.write(`Installed SonarQube runtime ${SONAR_VERSION} at ${result.runtimeDirectory}\n`);
  }
  process.stdout.write(`Pinned JGit ${JGIT_VERSION} is available at ${result.jgitPath}\n`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`SonarQube runtime installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
