const { readdirSync, readFileSync, writeFileSync, existsSync } = require("fs-extra");
const path = require("path");
const { pathToFileURL } = require("url");
const exec = (cmd, options) => new Promise((resolve, reject) => {
	require("child_process").exec(cmd, options, (err, stdout, stderr) => {
		if (err) {
			err.stdout = stdout;
			err.stderr = stderr;
			return reject(err);
		}
		resolve(stdout);
	});
});
const { log, loading, getText, colors, removeHomeDir } = global.utils;
const { GoatBot } = global;
const { configCommands } = GoatBot;
const regExpCheckPackage = /require(\s+|)\((\s+|)[`'"]([^`'"]+)[`'"](\s+|)\)/g;
const regExpCheckImport = /import(?:[\s\S]*?)from(\s+|)[`'"]([^`'"]+)[`'"]/g;
const packageAlready = [];
// const spinner = '\\|/-';
const spinner = [
	'⠋', '⠙', '⠹',
	'⠸', '⠼', '⠴',
	'⠦', '⠧', '⠇',
	'⠏'
];
let count = 0;

// ————————————————— NODE BUILT-IN MODULES ————————————————— //
// Never attempt to npm install these — they ship with Node.js itself.
const NODE_BUILTIN_MODULES = new Set([
	"fs", "path", "crypto", "os", "util", "stream", "url", "events",
	"child_process", "buffer", "http", "https", "zlib", "tls", "net",
	"dns", "querystring", "readline", "timers", "process", "worker_threads",
	"vm", "assert"
]);

// A few extra commonly-required core modules that show up across GoatBot
// forks; kept separate from the exact list requested so the required list
// above stays untouched, but still avoids pointless install attempts.
const EXTRA_BUILTIN_MODULES = new Set([
	"module", "constants", "string_decoder", "punycode", "domain",
	"perf_hooks", "async_hooks", "v8", "inspector", "cluster", "dgram",
	"repl", "trace_events", "tty", "diagnostics_channel"
]);

function isBuiltinModule(packageName) {
	let name = packageName;
	if (name.startsWith("node:"))
		name = name.slice(5);
	return NODE_BUILTIN_MODULES.has(name) || EXTRA_BUILTIN_MODULES.has(name);
}

// ————————————————— MODULE / EXPORT NORMALIZATION ————————————————— //
// Resolve whatever shape a command file exported into a single plain
// command object, regardless of whether it came from:
//   - module.exports = {...}                 (classic CommonJS)
//   - exports.default = {...}                (transpiled ESM default export)
//   - export default {...}                   (native ESM, loaded via import())
//   - named exports (export const config = ...; export function onStart ...)
function resolveCommandExport(mod) {
	if (!mod)
		return mod;

	let resolved = mod;

	// If the top-level export already looks like a usable command (has its
	// own onStart/onCall/run/execute or config), ALWAYS prefer it as-is.
	// Only fall back to unwrapping `.default` when the top level itself has
	// nothing usable — i.e. genuine ESM/Babel interop where the real command
	// only exists under `.default`. Previously this unwrapped `.default`
	// whenever it merely "looked like" a command, which could silently
	// discard a perfectly valid top-level CommonJS command (e.g. one that
	// also happens to carry an unrelated `default` field) and surface as
	// "onStart of command undefined" even though onStart was right there.
	const topLevelUsable = typeof mod === "object" && (
		mod.config || mod.onStart || mod.onCall || mod.run || mod.execute
	);

	if (!topLevelUsable && typeof mod === "object" && mod.default && typeof mod.default === "object") {
		const def = mod.default;
		const looksLikeCommand = def.config || def.onStart || def.onCall ||
			def.onChat || def.onEvent || def.onReply || def.onReaction || def.run || def.execute;
		if (looksLikeCommand)
			resolved = def;
	}

	// ES Module namespace objects (what `import()` returns for a file using
	// named exports, e.g. `export const config = ...; export function
	// onStart(){}`) are sealed/non-extensible per spec. Downstream code
	// needs to assign `command.location`, backfill `command.onCall`, and
	// normalize `command.config` in place — all of which THROW on a real
	// namespace object. Copy it into a plain, mutable object first.
	if (resolved && typeof resolved === "object" &&
		(!Object.isExtensible(resolved) || Object.isSealed(resolved) || Object.isFrozen(resolved))) {
		resolved = { ...resolved };
	}

	return resolved;
}

// Normalize handler naming differences between GoatBot forks:
// onCall / onStart / run / execute are all treated as the "main" handler.
function normalizeCommandStructure(command) {
	if (!command || typeof command !== "object")
		return command;

	const handlerAliasNames = ["onStart", "onCall", "run", "execute"];

	if (typeof command.onStart !== "function") {
		const altHandlerName = handlerAliasNames.find(name => typeof command[name] === "function");
		if (altHandlerName)
			command.onStart = command[altHandlerName];
	}
	if (typeof command.onCall !== "function" && typeof command.onStart === "function")
		command.onCall = command.onStart;

	// onChat / onReply / onReaction / onLoad / onEvent / onAnyEvent are
	// left untouched here — they're consumed elsewhere in the framework —
	// this just makes sure they survive whatever export shape was used.
	return command;
}

// Apply safe defaults for missing config fields instead of throwing,
// so commands from forks with looser config requirements still load.
function normalizeConfigDefaults(configCommand, text) {
	if (!configCommand.category) {
		configCommand.category = "other";
	}
	if (!configCommand.permissions) {
		configCommand.permissions = [0];
	}
	if (configCommand.cooldown === undefined || configCommand.cooldown === null) {
		configCommand.cooldown = 3;
	}
	if (!configCommand.aliases) {
		configCommand.aliases = [];
	}
	if (!configCommand.version) {
		configCommand.version = "1.0.0";
	}
	if (!configCommand.author) {
		configCommand.author = "Unknown";
	}
	return configCommand;
}

// ————————————————— DUPLICATE CLEANUP ————————————————— //
// When a newer file defines a command/event with a name that's already
// registered, tear down every trace of the old one before registering the
// new one, so the newest definition always wins instead of crashing.
function unregisterCommand(setMap, folderModules, normalizedName) {
	if (!GoatBot[setMap].has(normalizedName))
		return;

	GoatBot[setMap].delete(normalizedName);

	for (const [alias, target] of GoatBot.aliases) {
		if (target === normalizedName)
			GoatBot.aliases.delete(alias);
	}

	const removeFromArray = (arr) => {
		if (!Array.isArray(arr))
			return;
		for (let i = arr.length - 1; i >= 0; i--) {
			if (arr[i] === normalizedName)
				arr.splice(i, 1);
		}
	};
	removeFromArray(GoatBot.onChat);
	removeFromArray(GoatBot.onEvent);
	removeFromArray(GoatBot.onAnyEvent);

	if (Array.isArray(GoatBot.onFirstChat))
		GoatBot.onFirstChat = GoatBot.onFirstChat.filter(item => item.commandName !== normalizedName);

	const filePathKey = folderModules == "cmds" ? "commandFilesPath" : "eventCommandsFilesPath";
	if (Array.isArray(global.GoatBot[filePathKey]))
		global.GoatBot[filePathKey] = global.GoatBot[filePathKey].filter(item => !(item.commandName || []).includes(normalizedName));
}

// ————————————————— LOAD A SINGLE FILE (CJS or ESM) ————————————————— //
async function requireCommandFile(pathCommand) {
	const isMjs = pathCommand.endsWith(".mjs");

	if (isMjs) {
		const mod = await import(pathToFileURL(pathCommand).href);
		return mod;
	}

	try {
		return require(pathCommand);
	}
	catch (err) {
		// Only treat this as "the file is actually ESM" for Node's own,
		// version-stable signals — NOT loose message-content guessing.
		// ERR_REQUIRE_ESM is the official code Node throws when require()
		// hits a module that IS genuinely ESM per package.json/extension.
		// The two SyntaxError messages below are Node's exact, unchanging
		// wording for hitting `import`/`export` syntax while parsing a
		// file as a script/CJS module. Matching anything looser here risks
		// catching an unrelated error thrown by the command's own code
		// (e.g. a validation message that happens to mention "export" or
		// "module") and wrongly rerouting a normal CommonJS file through
		// dynamic import() — which then breaks any __dirname/__filename
		// usage in that file, since those simply don't exist in real ESM.
		const isRealEsmSignal =
			(err && err.code === "ERR_REQUIRE_ESM") ||
			(err instanceof SyntaxError && (
				/Unexpected token ['"]export['"]/.test(err.message || "") ||
				/Cannot use import statement outside a module/.test(err.message || "")
			));

		if (isRealEsmSignal) {
			const mod = await import(pathToFileURL(pathCommand).href);
			return mod;
		}

		throw err;
	}
}

module.exports = async function (api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, createLine) {
	/* { CHECK ORIGIN CODE } */

	const aliasesData = await globalData.get('setalias', 'data', []);
	if (aliasesData) {
		for (const data of aliasesData) {
			const { aliases, commandName } = data;
			for (const alias of aliases)
				if (GoatBot.aliases.has(alias))
					throw new Error(`Alias "${alias}" already exists in command "${commandName}"`);
				else
					GoatBot.aliases.set(alias, commandName);
		}
	}
	const folders = ["cmds", "events"];
	let text, setMap, typeEnvCommand;

	for (const folderModules of folders) {
		const makeColor = folderModules == "cmds" ?
			createLine("LOAD COMMANDS") :
			createLine("LOAD COMMANDS EVENT");
		console.log(colors.hex("#f5ab00")(makeColor));

		if (folderModules == "cmds") {
			text = "command";
			typeEnvCommand = "envCommands";
			setMap = "commands";
		}
		else if (folderModules == "events") {
			text = "event command";
			typeEnvCommand = "envEvents";
			setMap = "eventCommands";
		}

		const fullPathModules = path.normalize(process.cwd() + `/scripts/${folderModules}`);
		const Files = readdirSync(fullPathModules)
			.filter(file =>
				(file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) &&
				!file.endsWith("eg.js") && !file.endsWith("eg.mjs") && !file.endsWith("eg.cjs") && // ignore example file
				(process.env.NODE_ENV == "development" ? true : !file.match(/(dev)\.(m|c)?js$/g)) && // ignore dev file in production mode
				!configCommands[folderModules == "cmds" ? "commandUnload" : "commandEventUnload"]?.includes(file) // ignore unload command
			);

		const commandError = [];
		let commandLoadSuccess = 0;

		for (const file of Files) {
			const pathCommand = path.normalize(fullPathModules + "/" + file);
			let commandNameForLog = file;
			try {
				// ————————————————— CHECK PACKAGE ————————————————— //
				const contentFile = readFileSync(pathCommand, "utf8");
				const foundPackages = [];

				let allPackage = contentFile.match(regExpCheckPackage);
				if (allPackage)
					foundPackages.push(...allPackage.map(p => p.match(/[`'"]([^`'"]+)[`'"]/)[1]));

				// Also catch ES Module style `import x from "pkg"` so forks
				// that ship native-ESM commands still get their
				// dependencies auto-installed.
				let match;
				regExpCheckImport.lastIndex = 0;
				while ((match = regExpCheckImport.exec(contentFile)) !== null)
					foundPackages.push(match[2]);

				if (foundPackages.length) {
					const cleanedPackages = foundPackages
						.filter(p => p.indexOf("/") !== 0 && p.indexOf("./") !== 0 && p.indexOf("../") !== 0 && p.indexOf(__dirname) !== 0);

					for (let packageName of cleanedPackages) {
						// @user/abc => @user/abc
						// @user/abc/dist/xyz.js => @user/abc
						// @user/abc/dist/xyz => @user/abc
						if (packageName.startsWith('@'))
							packageName = packageName.split('/').slice(0, 2).join('/');
						else
							packageName = packageName.split('/')[0];

						// ————————— SKIP NODE BUILT-IN MODULES ————————— //
						if (isBuiltinModule(packageName))
							continue;

						if (!packageAlready.includes(packageName)) {
							packageAlready.push(packageName);
							if (!existsSync(`${process.cwd()}/node_modules/${packageName}`)) {
								const wating = setInterval(() => {
									// loading.info('PACKAGE', `${spinner[count % spinner.length]} Installing package ${packageName} for ${text} ${file}`);
									loading.info('PACKAGE', `${spinner[count % spinner.length]} Installing package ${colors.yellow(packageName)} for ${text} ${colors.yellow(file)}`);
									count++;
								}, 80);
								try {
									await exec(`npm install ${packageName} --${pathCommand.endsWith('.dev.js') ? 'no-save' : 'save'}`);
									clearInterval(wating);
									process.stderr.write('\r\x1b[K');
									console.log(`${colors.green('✔')} installed package ${packageName} successfully`);
								}
								catch (err) {
									clearInterval(wating);
									process.stderr.write('\r\x1b[K');
									console.log(`${colors.red('✖')} installed package ${packageName} failed`);
									const npmOutput = (err.stderr || err.stdout || err.message || "").toString().trim();
									if (npmOutput)
										console.log(colors.gray(npmOutput));
									log.warn('PACKAGE', `Failed to install "${packageName}" for ${text} "${file}" — skipping this ${text}, continuing to load others.\n${npmOutput}`);
									throw new Error(`Can't install package ${packageName}${npmOutput ? `: ${npmOutput.split("\n")[0]}` : ""}`);
								}
							}
						}
					}
				}

				// —————————————— CHECK CONTENT SCRIPT —————————————— //
				global.temp.contentScripts[folderModules][file] = contentFile;

				// —————————————— REQUIRE / IMPORT (CJS + ESM) —————————————— //
				const rawModule = await requireCommandFile(pathCommand);
				const command = resolveCommandExport(rawModule);
				if (!command || typeof command !== "object")
					throw new Error(`${text} "${file}" did not export a valid command object (module.exports / export default / named exports)`);

				normalizeCommandStructure(command);
				command.location = pathCommand;

				let configCommand = command.config;
				// ——————————————— CHECK SYNTAXERROR ——————————————— //
				if (!configCommand)
					throw new Error(`config of ${text} undefined`);

				configCommand = normalizeConfigDefaults(configCommand, text);
				command.config = configCommand;

				const commandName = configCommand.name;
				if (!commandName)
					throw new Error(`name of ${text} undefined`);
				commandNameForLog = commandName;

				if (!command.onStart)
					throw new Error(`onStart of ${text} undefined`);
				if (typeof command.onStart !== "function")
					throw new Error(`onStart of ${text} must be a function`);

				const normalizedName = String(commandName).toLowerCase();

				// ————————— DUPLICATE COMMAND: KEEP NEWEST ————————— //
				if (GoatBot[setMap].has(normalizedName)) {
					log.warn('LOADED', `Duplicate ${text} name "${commandName}" found in "${removeHomeDir(pathCommand)}" — replacing the previous definition, keeping the newest one.`);
					unregisterCommand(setMap, folderModules, normalizedName);
				}

				const { onFirstChat, onChat, onLoad, onEvent, onAnyEvent } = command;
				const { envGlobal, envConfig } = configCommand;
				const { aliases } = configCommand;
				// ————————————————— CHECK ALIASES —————————————————— //
				const validAliases = [];
				if (aliases) {
					if (!Array.isArray(aliases)) {
						log.warn('LOADED', `The value of "config.aliases" for ${text} "${commandName}" must be an array — ignoring aliases for this ${text}.`);
					}
					else {
						for (const aliasRaw of aliases) {
							const alias = String(aliasRaw).toLowerCase();
							if (validAliases.includes(alias)) {
								log.warn('LOADED', `Duplicate alias "${aliasRaw}" in ${text} "${commandName}" with file "${removeHomeDir(pathCommand)}" — skipping duplicate.`);
								continue;
							}
							if (GoatBot.aliases.has(alias) && GoatBot.aliases.get(alias) !== normalizedName) {
								log.warn('LOADED', `Alias "${aliasRaw}" already exists in ${text} "${GoatBot.aliases.get(alias)}" — skipping for "${commandName}" (file: "${removeHomeDir(pathCommand)}").`);
								continue;
							}
							validAliases.push(alias);
						}
						for (const alias of validAliases)
							GoatBot.aliases.set(alias, normalizedName);
					}
				}
				// ——————————————— CHECK ENV GLOBAL ——————————————— //
				if (envGlobal) {
					if (typeof envGlobal != "object" || typeof envGlobal == "object" && Array.isArray(envGlobal))
						throw new Error("the value of \"envGlobal\" must be object");
					for (const i in envGlobal) {
						if (!configCommands.envGlobal[i]) {
							configCommands.envGlobal[i] = envGlobal[i];
						}
						else {
							const readCommand = readFileSync(pathCommand, "utf-8").replace(envGlobal[i], configCommands.envGlobal[i]);
							writeFileSync(pathCommand, readCommand);
						}
					}
				}
				// ———————————————— CHECK CONFIG CMD ——————————————— //
				if (envConfig) {
					if (typeof envConfig != "object" || typeof envConfig == "object" && Array.isArray(envConfig))
						throw new Error("The value of \"envConfig\" must be object");
					if (!configCommands[typeEnvCommand])
						configCommands[typeEnvCommand] = {};
					if (!configCommands[typeEnvCommand][commandName])
						configCommands[typeEnvCommand][commandName] = {};
					for (const [key, value] of Object.entries(envConfig)) {
						if (!configCommands[typeEnvCommand][commandName][key])
							configCommands[typeEnvCommand][commandName][key] = value;
						else {
							const readCommand = readFileSync(pathCommand, "utf-8").replace(value, configCommands[typeEnvCommand][commandName][key]);
							writeFileSync(pathCommand, readCommand);
						}
					}
				}
				// ————————————————— CHECK ONLOAD ————————————————— //
				if (onLoad) {
					if (typeof onLoad != "function")
						throw new Error("The value of \"onLoad\" must be function");
					await onLoad({ api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData });
				}
				// ——————————————— CHECK RUN ANYTIME ——————————————— //
				if (onChat)
					GoatBot.onChat.push(normalizedName);
				// ——————————————— CHECK ONFIRSTCHAT ——————————————— //
				if (onFirstChat)
					GoatBot.onFirstChat.push({ commandName: normalizedName, threadIDsChattedFirstTime: [] });
				// ————————————————— CHECK ONEVENT ————————————————— //
				if (onEvent)
					GoatBot.onEvent.push(normalizedName);
				// ———————————————— CHECK ONANYEVENT ———————————————— //
				if (onAnyEvent)
					GoatBot.onAnyEvent.push(normalizedName);
				// —————————————— IMPORT TO GLOBALGOAT —————————————— //
				GoatBot[setMap].set(normalizedName, command);
				commandLoadSuccess++;
				// ————————————————— COMPARE COMMAND (removed in open source) ————————————————— //

				global.GoatBot[folderModules == "cmds" ? "commandFilesPath" : "eventCommandsFilesPath"].push({
					// filePath: pathCommand,
					filePath: path.normalize(pathCommand),
					commandName: [normalizedName, ...validAliases]
				});
			}
			catch (error) {
				commandError.push({
					name: commandNameForLog,
					file,
					error
				});
			}
			loading.info('LOADED', `${colors.green(`${commandLoadSuccess}`)}${commandError.length ? `, ${colors.red(`${commandError.length}`)}` : ''}`);
		}
		console.log("\r");
		if (commandError.length > 0) {
			log.err("LOADED", getText('ipts', 'iptsError', colors.yellow(text)));
			for (const item of commandError) {
				console.log(` ${colors.red('✖ ' + item.file)}${item.name && item.name !== item.file ? ` (${item.name})` : ''}: ${item.error.message}`);
				if (item.error.stack)
					console.log(colors.gray(item.error.stack));
			}
		}
	}
};
