import { isSkillName } from "@deepseek-ai/dsh-skill";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, parseDocument } from "yaml";
//#region src/protocol.ts
const API = {
	list: "/api/dsh-skill-manager/skills",
	detail: "/api/dsh-skill-manager/skill",
	invocation: "/api/dsh-skill-manager/invocation"
};
//#endregion
//#region src/skill-file.ts
const WRITABLE_SOURCES = /* @__PURE__ */ new Set([
	"project-dsh",
	"project-agents",
	"user-dsh",
	"user-agents",
	"custom"
]);
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5e3;
const LOCK_STALE_MS = 3e4;
var SkillUpdateConflict = class extends Error {
	name = "SkillUpdateConflict";
};
function findClosingFrontmatter(raw, start) {
	let lineStart = start;
	while (lineStart <= raw.length) {
		const newline = raw.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? raw.length : newline;
		if (raw.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") return { start: lineStart };
		if (newline < 0) return void 0;
		lineStart = newline + 1;
	}
}
/** Update only the canonical invocation keys while preserving body text and YAML comments. */
function renderInvocationPolicy(raw, expectedName, invocation) {
	const firstLineEnd = raw.indexOf("\n");
	if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, "") !== "---") throw new Error(`skill "${expectedName}" has no YAML frontmatter`);
	const start = firstLineEnd + 1;
	const closing = findClosingFrontmatter(raw, start);
	if (closing === void 0) throw new Error(`skill "${expectedName}" has unclosed YAML frontmatter`);
	const document = parseDocument(raw.slice(start, closing.start), {
		prettyErrors: true,
		uniqueKeys: true
	});
	if (document.errors.length > 0 || !isMap(document.contents)) throw new Error(`skill "${expectedName}" has invalid YAML frontmatter`);
	if (document.get("name") !== expectedName) throw new Error(`skill "${expectedName}" changed identity before update`);
	document.set("disable-model-invocation", !invocation.modelInvocable);
	document.set("user-invocable", invocation.userInvocable);
	const newline = raw.slice(0, firstLineEnd).endsWith("\r") ? "\r\n" : "\n";
	const frontmatter = document.toString().replaceAll("\n", newline);
	return `${raw.slice(0, start)}${frontmatter}${raw.slice(closing.start)}`;
}
async function directEntryIsWritable(skill) {
	if (skill.path === void 0 || !WRITABLE_SOURCES.has(skill.source)) return false;
	try {
		const file = await lstat(skill.path);
		if (!file.isFile() || file.isSymbolicLink()) return false;
		if (skill.resourceBase?.kind === "directory") {
			if ((await lstat(skill.resourceBase.path)).isSymbolicLink()) return false;
			const childPath = relative(resolve(skill.resourceBase.path), resolve(skill.path));
			if (childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) return false;
			const [resolvedBase, resolvedPath] = await Promise.all([realpath(skill.resourceBase.path), realpath(skill.path)]);
			if (resolvedPath !== resolve(resolvedBase, childPath)) return false;
		}
		return true;
	} catch {
		return false;
	}
}
async function isWritableSkill(skill) {
	return await directEntryIsWritable(skill);
}
async function sleep(ms) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
async function acquireLock(path) {
	const lockPath = path + ".dsh-skill-manager.lock";
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) try {
		await mkdir(lockPath, { mode: 448 });
		const token = randomUUID();
		const ownerPath = join(lockPath, "owner");
		try {
			await writeFile(ownerPath, token, {
				encoding: "utf8",
				flag: "wx",
				mode: 384
			});
		} catch (error) {
			await rm(lockPath, {
				recursive: true,
				force: true
			}).catch(() => void 0);
			throw error;
		}
		return async () => {
			try {
				if (await readFile(ownerPath, "utf8") !== token) return;
				await rm(lockPath, {
					recursive: true,
					force: true
				});
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		};
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		try {
			const lock = await stat(lockPath);
			if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
				await rm(lockPath, {
					recursive: true,
					force: true
				});
				continue;
			}
		} catch (inspectError) {
			if (inspectError.code === "ENOENT") continue;
			throw inspectError;
		}
		if (Date.now() >= deadline) throw new SkillUpdateConflict(`skill "${basename(path)}" is busy; try again`);
		await sleep(LOCK_WAIT_MS);
	}
}
async function atomicReplace(path, content, mode) {
	const directory = dirname(path);
	const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(temporary, "wx", mode & 511);
		await handle.chmod(mode & 511);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = void 0;
		await rename(temporary, path);
		try {
			const directoryHandle = await open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		} catch {}
	} finally {
		if (handle !== void 0) await handle.close().catch(() => void 0);
		await rm(temporary, { force: true }).catch(() => void 0);
	}
}
/** Safely mutate one already-resolved, direct disk-backed Skill definition. */
async function updateSkillInvocation(skill, invocation) {
	if (!await directEntryIsWritable(skill) || skill.path === void 0) throw new SkillUpdateConflict(`skill "${skill.name}" is read-only`);
	const release = await acquireLock(skill.path);
	try {
		const info = await lstat(skill.path);
		if (!info.isFile() || info.isSymbolicLink()) throw new SkillUpdateConflict(`skill "${skill.name}" is read-only`);
		const raw = await readFile(skill.path, "utf8");
		let next;
		try {
			next = renderInvocationPolicy(raw, skill.name, invocation);
		} catch (error) {
			throw new SkillUpdateConflict(error instanceof Error ? error.message : `skill "${skill.name}" cannot be updated`);
		}
		await atomicReplace(skill.path, next, info.mode);
	} finally {
		await release();
	}
}
//#endregion
//#region src/routes.ts
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SESSION_ID_LENGTH = 256;
var RouteError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (![
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(hostUrl.hostname)) return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
function json(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer"
	});
	response.end(JSON.stringify(body));
}
function fail(response, status, message) {
	json(response, status, { error: message });
}
async function readJson(request) {
	if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new RouteError(415, "content-type must be application/json");
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new RouteError(413, "request body is too large");
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RouteError(400, "request body must be valid JSON");
	}
}
function stringField(value, key) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const field = value[key];
	return typeof field === "string" ? field : void 0;
}
function booleanField(value, key) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const field = value[key];
	return typeof field === "boolean" ? field : void 0;
}
function validateSessionId(value) {
	if (value === null || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) return void 0;
	return value;
}
function requestUrl(request) {
	return new URL(request.url ?? "/", "http://localhost");
}
function viewFor(ctx, sessionId) {
	const session = ctx.sessions.get(sessionId);
	if (session === void 0) throw new RouteError(404, "session not found");
	if (session.header.cwd === void 0) throw new RouteError(404, "session has no project directory");
	const live = ctx.agents.get(sessionId);
	const scoped = live === void 0 ? void 0 : ctx.agentPresets.serviceFor(live, "skills");
	return {
		cwd: session.header.cwd,
		registry: scoped ?? ctx.skills,
		scope: live
	};
}
async function entryOf(skill) {
	if (skill.path === void 0) return void 0;
	return {
		name: skill.name,
		description: skill.description,
		...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
		modelInvocable: skill.invocation.modelInvocable,
		userInvocable: skill.invocation.userInvocable,
		source: skill.source,
		provider: skill.provider,
		path: skill.path,
		writable: await isWritableSkill(skill)
	};
}
async function definitionFor(ctx, sessionId, name) {
	const view = viewFor(ctx, sessionId);
	const skill = await view.registry.get(name, {
		cwd: view.cwd,
		scope: view.scope
	});
	if (skill === void 0 || skill.path === void 0) throw new RouteError(404, "skill not found");
	return skill;
}
function failFromError(response, error, fallback) {
	if (error instanceof RouteError) return fail(response, error.status, error.message);
	if (error instanceof SkillUpdateConflict) return fail(response, 409, error.message);
	fail(response, 500, fallback);
}
function exact(path, handler) {
	return {
		kind: "exact",
		path,
		handler
	};
}
function makeRoutes(ctx) {
	return [
		exact(API.list, async (request, response) => {
			if (!isLoopbackRequest(request)) return fail(response, 403, "loopback access only");
			if (request.method !== "GET") return fail(response, 405, "method not allowed");
			const sessionId = validateSessionId(requestUrl(request).searchParams.get("sessionId"));
			if (sessionId === void 0) return fail(response, 400, "invalid sessionId");
			try {
				const view = viewFor(ctx, sessionId);
				const snapshot = await view.registry.snapshot({
					cwd: view.cwd,
					scope: view.scope
				});
				const definitions = await Promise.all(snapshot.skills.map((skill) => view.registry.get(skill.name, {
					cwd: view.cwd,
					scope: view.scope
				})));
				json(response, 200, {
					skills: (await Promise.all(definitions.map(async (skill) => skill === void 0 ? void 0 : await entryOf(skill)))).filter((entry) => entry !== void 0),
					complete: snapshot.complete
				});
			} catch (error) {
				failFromError(response, error, "unable to list skills");
			}
		}),
		exact(API.detail, async (request, response) => {
			if (!isLoopbackRequest(request)) return fail(response, 403, "loopback access only");
			if (request.method !== "GET") return fail(response, 405, "method not allowed");
			const url = requestUrl(request);
			const sessionId = validateSessionId(url.searchParams.get("sessionId"));
			const name = url.searchParams.get("name");
			if (sessionId === void 0 || name === null || !isSkillName(name)) return fail(response, 400, "invalid request");
			try {
				const skill = await definitionFor(ctx, sessionId, name);
				const entry = await entryOf(skill);
				if (entry === void 0) return fail(response, 404, "skill not found");
				json(response, 200, { skill: {
					...entry,
					content: skill.content
				} });
			} catch (error) {
				failFromError(response, error, "unable to read skill");
			}
		}),
		exact(API.invocation, async (request, response) => {
			if (!isLoopbackRequest(request)) return fail(response, 403, "loopback access only");
			if (request.method !== "POST") return fail(response, 405, "method not allowed");
			try {
				const body = await readJson(request);
				const sessionId = validateSessionId(stringField(body, "sessionId") ?? null);
				const name = stringField(body, "name");
				const modelInvocable = booleanField(body, "modelInvocable");
				const userInvocable = booleanField(body, "userInvocable");
				if (sessionId === void 0 || name === void 0 || !isSkillName(name) || modelInvocable === void 0 || userInvocable === void 0) return fail(response, 400, "invalid request");
				const payload = {
					sessionId,
					name,
					modelInvocable,
					userInvocable
				};
				const skill = await definitionFor(ctx, payload.sessionId, payload.name);
				await updateSkillInvocation(skill, payload);
				const entry = await entryOf({
					...skill,
					invocation: {
						modelInvocable,
						userInvocable
					}
				});
				if (entry === void 0) return fail(response, 409, "skill is not disk-backed");
				json(response, 200, { skill: entry });
			} catch (error) {
				failFromError(response, error, "unable to update skill");
			}
		})
	];
}
//#endregion
//#region src/index.ts
const name = "skill-manager";
const inject = [
	"webServer",
	"skills",
	"sessions",
	"agents",
	"agentPresets"
];
function apply(ctx) {
	ctx.effect(() => {
		const disposers = makeRoutes(ctx).map((route) => ctx.webServer.register(route));
		return () => {
			for (const dispose of disposers) dispose();
		};
	}, "dsh-skill-manager: loopback routes");
}
//#endregion
export { apply, inject, name };
