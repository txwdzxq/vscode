/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ExecOptionsWithStringEncoding } from 'child_process';
import { upstreamSpecs } from './constants';
import codeCompletionSpec from './completions/code';
import cdSpec from './completions/cd';
import codeInsidersCompletionSpec from './completions/code-insiders';
import { osIsWindows } from './helpers/os';
import type { ICompletionResource } from './types';
import { getBashGlobals } from './shell/bash';
import { getZshGlobals } from './shell/zsh';
import { getFishGlobals } from './shell/fish';
import { getPwshGlobals } from './shell/pwsh';
import { getTokenType, TokenType } from './tokens';
import { PathExecutableCache } from './env/pathExecutableCache';
import { getFriendlyResourcePath } from './helpers/uri';
import { ArgumentParserResult, parseArguments } from './fig/autocomplete-parser/parseArguments';
import { getCommand, type Command } from './fig/shell-parser/command';
import { SuggestionFlag } from './fig/shared/utils';
import { spawnHelper } from './shell/common';

// TODO: remove once API is finalized
export const enum TerminalShellType {
	Sh = 1,
	Bash = 2,
	Fish = 3,
	Csh = 4,
	Ksh = 5,
	Zsh = 6,
	CommandPrompt = 7,
	GitBash = 8,
	PowerShell = 9,
	Python = 10,
	Julia = 11,
	NuShell = 12,
	Node = 13
}

const isWindows = osIsWindows();
const cachedGlobals: Map<TerminalShellType, ICompletionResource[] | undefined> = new Map();
let pathExecutableCache: PathExecutableCache;

export const availableSpecs: Fig.Spec[] = [
	cdSpec,
	codeInsidersCompletionSpec,
	codeCompletionSpec,
];
for (const spec of upstreamSpecs) {
	availableSpecs.push(require(`./completions/upstream/${spec}`).default);
}

const getShellSpecificGlobals: Map<TerminalShellType, (options: ExecOptionsWithStringEncoding, existingCommands?: Set<string>) => Promise<(string | ICompletionResource)[]>> = new Map([
	[TerminalShellType.Bash, getBashGlobals],
	[TerminalShellType.Zsh, getZshGlobals],
	// TODO: Ghost text in the command line prevents completions from working ATM for fish
	[TerminalShellType.Fish, getFishGlobals],
	[TerminalShellType.PowerShell, getPwshGlobals],
]);

async function getShellGlobals(shellType: TerminalShellType, existingCommands?: Set<string>): Promise<ICompletionResource[] | undefined> {
	try {
		const cachedCommands = cachedGlobals.get(shellType);
		if (cachedCommands) {
			return cachedCommands;
		}
		const shell = getShell(shellType);
		if (!shell) {
			return;
		}
		const options: ExecOptionsWithStringEncoding = { encoding: 'utf-8', shell };
		const mixedCommands: (string | ICompletionResource)[] | undefined = await getShellSpecificGlobals.get(shellType)?.(options, existingCommands);
		const normalizedCommands = mixedCommands?.map(command => typeof command === 'string' ? ({ label: command }) : command);
		cachedGlobals.set(shellType, normalizedCommands);
		return normalizedCommands;

	} catch (error) {
		console.error('Error fetching builtin commands:', error);
		return;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	pathExecutableCache = new PathExecutableCache();
	context.subscriptions.push(pathExecutableCache);

	context.subscriptions.push(vscode.window.registerTerminalCompletionProvider({
		id: 'terminal-suggest',
		async provideTerminalCompletions(terminal: vscode.Terminal, terminalContext: { commandLine: string; cursorPosition: number }, token: vscode.CancellationToken): Promise<vscode.TerminalCompletionItem[] | vscode.TerminalCompletionList | undefined> {
			if (token.isCancellationRequested) {
				return;
			}

			const shellType: TerminalShellType | undefined = 'shellType' in terminal.state ? terminal.state.shellType as TerminalShellType : undefined;
			if (!shellType) {
				return;
			}

			const commandsInPath = await pathExecutableCache.getExecutablesInPath(terminal.shellIntegration?.env);
			const shellGlobals = await getShellGlobals(shellType, commandsInPath?.labels) ?? [];
			if (!commandsInPath?.completionResources) {
				return;
			}
			const commands = [...commandsInPath.completionResources, ...shellGlobals];
			const prefix = getPrefix(terminalContext.commandLine, terminalContext.cursorPosition);
			const pathSeparator = isWindows ? '\\' : '/';
			const tokenType = getTokenType(terminalContext, shellType);
			const result = await getCompletionItemsFromSpecs(availableSpecs, terminalContext, commands, prefix, tokenType, terminal.shellIntegration?.cwd, getEnvAsRecord(terminal.shellIntegration?.env), terminal.name, token);
			if (terminal.shellIntegration?.env) {
				const homeDirCompletion = result.items.find(i => i.label === '~');
				if (homeDirCompletion && terminal.shellIntegration.env.HOME) {
					homeDirCompletion.documentation = getFriendlyResourcePath(vscode.Uri.file(terminal.shellIntegration.env.HOME), pathSeparator, vscode.TerminalCompletionItemKind.Folder);
					homeDirCompletion.kind = vscode.TerminalCompletionItemKind.Folder;
				}
			}

			if (result.cwd && (result.filesRequested || result.foldersRequested)) {
				return new vscode.TerminalCompletionList(result.items, { filesRequested: result.filesRequested, foldersRequested: result.foldersRequested, cwd: result.cwd, env: terminal.shellIntegration?.env });
			}
			return result.items;
		}
	}, '/', '\\'));
}

/**
 * Adjusts the current working directory based on a given prefix if it is a folder.
 * @param prefix - The folder path prefix.
 * @param currentCwd - The current working directory.
 * @returns The new working directory.
 */
export async function resolveCwdFromPrefix(prefix: string, currentCwd?: vscode.Uri): Promise<vscode.Uri | undefined> {
	if (!currentCwd) {
		return;
	}
	try {
		// Get the nearest folder path from the prefix. This ignores everything after the `/` as
		// they are what triggers changes in the directory.
		let lastSlashIndex: number;
		if (isWindows) {
			// TODO: This support is very basic, ideally the slashes supported would depend upon the
			//       shell type. For example git bash under Windows does not allow using \ as a path
			//       separator.
			lastSlashIndex = prefix.lastIndexOf('\\');
			if (lastSlashIndex === -1) {
				lastSlashIndex = prefix.lastIndexOf('/');
			}
		} else {
			lastSlashIndex = prefix.lastIndexOf('/');
		}
		const relativeFolder = lastSlashIndex === -1 ? '' : prefix.slice(0, lastSlashIndex);

		// Resolve the absolute path of the prefix
		const resolvedPath = path.resolve(currentCwd?.fsPath, relativeFolder);

		const stat = await fs.stat(resolvedPath);

		// Check if the resolved path exists and is a directory
		if (stat.isDirectory()) {
			return currentCwd.with({ path: resolvedPath });
		}
	} catch {
		// Ignore errors
	}

	// If the prefix is not a folder, return the current cwd
	return currentCwd;
}
function getDescription(spec: Fig.Spec): string {
	if ('description' in spec) {
		return spec.description ?? '';
	}
	return '';
}

function getLabel(spec: Fig.Spec | Fig.Arg | Fig.Suggestion | string): string[] | undefined {
	if (typeof spec === 'string') {
		return [spec];
	}
	if (typeof spec.name === 'string') {
		return [spec.name];
	}
	if (!Array.isArray(spec.name) || spec.name.length === 0) {
		return;
	}
	return spec.name;
}

function createCompletionItem(cursorPosition: number, prefix: string, commandResource: ICompletionResource, detail?: string, documentation?: string | vscode.MarkdownString, kind?: vscode.TerminalCompletionItemKind): vscode.TerminalCompletionItem {
	const endsWithSpace = prefix.endsWith(' ');
	const lastWord = endsWithSpace ? '' : prefix.split(' ').at(-1) ?? '';
	return {
		label: commandResource.label,
		detail: detail ?? commandResource.detail ?? '',
		documentation,
		replacementIndex: cursorPosition - lastWord.length,
		replacementLength: lastWord.length,
		kind: kind ?? commandResource.kind ?? vscode.TerminalCompletionItemKind.Method
	};
}

function getPrefix(commandLine: string, cursorPosition: number): string {
	// Return an empty string if the command line is empty after trimming
	if (commandLine.trim() === '') {
		return '';
	}

	// Check if cursor is not at the end and there's non-whitespace after the cursor
	if (cursorPosition < commandLine.length && /\S/.test(commandLine[cursorPosition])) {
		return '';
	}

	// Extract the part of the line up to the cursor position
	const beforeCursor = commandLine.slice(0, cursorPosition);

	// Find the last sequence of non-whitespace characters before the cursor
	const match = beforeCursor.match(/(\S+)\s*$/);

	// Return the match if found, otherwise undefined
	return match ? match[0] : '';
}

export function asArray<T>(x: T | T[]): T[];
export function asArray<T>(x: T | readonly T[]): readonly T[];
export function asArray<T>(x: T | T[]): T[] {
	return Array.isArray(x) ? x : [x];
}

export type SpecArg = Fig.Arg | Fig.Suggestion | Fig.Option | string;

export async function collectCompletionItemResult(command: Command, parsedArguments: ArgumentParserResult, prefix: string, terminalContext: any, items: vscode.TerminalCompletionItem[]): Promise<{ filesRequested: boolean; foldersRequested: boolean } | undefined> {
	let filesRequested = false;
	let foldersRequested = false;

	const addSuggestions = async (specArgs: SpecArg[] | Record<string, SpecArg> | undefined, kind: vscode.TerminalCompletionItemKind, parsedArguments?: ArgumentParserResult) => {
		if (kind === vscode.TerminalCompletionItemKind.Argument && parsedArguments?.currentArg?.generators) {
			const generators = parsedArguments.currentArg.generators;
			for (const generator of generators) {
				if (generator.template) {
					const templates = Array.isArray(generator.template) ? generator.template : [generator.template];
					for (const template of templates) {
						if (template === 'filepaths') {
							filesRequested = true;
						} else if (template === 'folders') {
							foldersRequested = true;
						}
					}
				} else {
					if (generator.script && Array.isArray(generator.script) && generator.postProcess) {
						let output;
						try {
							output = await spawnHelper(generator.script[0], generator.script.slice(1), { encoding: 'utf8' }); //, { options });
						} catch {
							//ignore
						}
						if (!output) {
							continue;
						}
						const generatedItems = generator.postProcess(output, command.tokens.map(e => e.text));
						if (!generatedItems) {
							continue;
						}
						for (const generatedItem of generatedItems) {
							if (!generatedItem) {
								continue;
							}
							const suggestionLabels = getLabel(generatedItem);
							if (!suggestionLabels) {
								continue;
							}
							for (const label of suggestionLabels) {
								items.push(createCompletionItem(
									terminalContext.cursorPosition,
									prefix,
									{ label },
									undefined,
									typeof generatedItem === 'string' ? generatedItem : generatedItem.description,
									kind
								));
							}
						}
					}
				}
			}
		}
		if (!specArgs) {
			return { filesRequested, foldersRequested };
		}

		if (Array.isArray(specArgs)) {
			for (const item of specArgs) {
				const suggestionLabels = getLabel(item);
				if (!suggestionLabels) {
					continue;
				}
				for (const label of suggestionLabels) {
					items.push(
						createCompletionItem(
							terminalContext.cursorPosition,
							prefix,
							{ label },
							undefined,
							typeof item === 'string' ? item : item.description,
							kind
						)
					);
				}
			}
		} else {
			for (const [label, item] of Object.entries(specArgs)) {
				items.push(
					createCompletionItem(
						terminalContext.cursorPosition,
						prefix,
						{ label },
						undefined,
						typeof item === 'string' ? item : item.description,
						kind
					)
				);
			}
		}
	};

	if (parsedArguments.suggestionFlags & SuggestionFlag.Args) {
		await addSuggestions(parsedArguments.currentArg?.suggestions, vscode.TerminalCompletionItemKind.Argument, parsedArguments);
	}
	if (parsedArguments.suggestionFlags & SuggestionFlag.Subcommands) {
		await addSuggestions(parsedArguments.completionObj.subcommands, vscode.TerminalCompletionItemKind.Method);
	}
	if (parsedArguments.suggestionFlags & SuggestionFlag.Options) {
		await addSuggestions(parsedArguments.completionObj.options, vscode.TerminalCompletionItemKind.Flag);
	}

	return { filesRequested, foldersRequested };
}

export async function getCompletionItemsFromSpecs(
	specs: Fig.Spec[],
	terminalContext: { commandLine: string; cursorPosition: number },
	availableCommands: ICompletionResource[],
	prefix: string,
	tokenType: TokenType,
	shellIntegrationCwd: vscode.Uri | undefined,
	env: Record<string, string>,
	name: string,
	token?: vscode.CancellationToken
): Promise<{ items: vscode.TerminalCompletionItem[]; filesRequested: boolean; foldersRequested: boolean; cwd?: vscode.Uri }> {
	const items: vscode.TerminalCompletionItem[] = [];
	let filesRequested = false;
	let foldersRequested = false;

	let precedingText = terminalContext.commandLine.slice(0, terminalContext.cursorPosition + 1);
	if (isWindows) {
		const spaceIndex = precedingText.indexOf(' ');
		const commandEndIndex = spaceIndex === -1 ? precedingText.length : spaceIndex;
		const lastDotIndex = precedingText.lastIndexOf('.', commandEndIndex);
		if (lastDotIndex > 0) { // Don't treat dotfiles as extensions
			precedingText = precedingText.substring(0, lastDotIndex) + precedingText.substring(spaceIndex);
		}
	}

	let hasCurrentArg = false;
	for (const spec of specs) {
		const specLabels = getLabel(spec);

		if (!specLabels) {
			continue;
		}

		for (const specLabel of specLabels) {
			const availableCommand = (isWindows
				? availableCommands.find(command => command.label.match(new RegExp(`${specLabel}(\\.[^ ]+)?$`)))
				: availableCommands.find(command => command.label.startsWith(specLabel)));
			if (!availableCommand || (token && token.isCancellationRequested)) {
				continue;
			}

			// push it to the completion items
			if (tokenType === TokenType.Command) {
				if (availableCommand.kind !== vscode.TerminalCompletionItemKind.Alias) {
					items.push(createCompletionItem(terminalContext.cursorPosition, prefix, { label: specLabel }, getDescription(spec), availableCommand.detail));
				}
				continue;
			}

			const commandAndAliases = (isWindows
				? availableCommands.filter(command => specLabel === removeAnyFileExtension(command.definitionCommand ?? command.label))
				: availableCommands.filter(command => specLabel === (command.definitionCommand ?? command.label)));
			if (
				!(isWindows
					? commandAndAliases.some(e => precedingText.startsWith(`${removeAnyFileExtension(e.label)} `))
					: commandAndAliases.some(e => precedingText.startsWith(`${e.label} `)))
			) {
				// the spec label is not the first word in the command line, so do not provide options or args
				continue;
			}

			const command = getCommand(terminalContext.commandLine, {}, terminalContext.cursorPosition);
			if (!command || !shellIntegrationCwd) {
				continue;
			}
			const parsedArguments: ArgumentParserResult = await parseArguments(
				command,
				{ environmentVariables: env, currentWorkingDirectory: shellIntegrationCwd.fsPath, sshPrefix: '', currentProcess: name, /* TODO: pass in aliases */ },
				spec,
			);
			hasCurrentArg ||= !!parsedArguments.currentArg;
			const completionItemResult = await collectCompletionItemResult(command, parsedArguments, prefix, terminalContext, items);
			if (completionItemResult) {
				filesRequested ||= completionItemResult.filesRequested;
				foldersRequested ||= completionItemResult.foldersRequested;
			}
		}
	}

	if (tokenType === TokenType.Command) {
		// Include builitin/available commands in the results
		const labels = new Set(items.map((i) => i.label));
		for (const command of availableCommands) {
			if (!labels.has(command.label)) {
				items.push(createCompletionItem(terminalContext.cursorPosition, prefix, command, command.detail));
			}
		}
		filesRequested = true;
		foldersRequested = true;
	} else if (!items.length && !filesRequested && !foldersRequested && !hasCurrentArg) {
		// Not a command and no specific args or options were provided, so show resources
		filesRequested = true;
		foldersRequested = true;
	}

	let cwd: vscode.Uri | undefined;
	if (shellIntegrationCwd && (filesRequested || foldersRequested)) {
		cwd = await resolveCwdFromPrefix(prefix, shellIntegrationCwd) ?? shellIntegrationCwd;
	}

	return { items, filesRequested, foldersRequested, cwd };
}

function getShell(shellType: TerminalShellType): string | undefined {
	switch (shellType) {
		case TerminalShellType.Bash:
			return 'bash';
		case TerminalShellType.Fish:
			return 'fish';
		case TerminalShellType.Zsh:
			return 'zsh';
		case TerminalShellType.PowerShell:
			return 'pwsh';
		default: {
			return undefined;
		}
	}
}

function removeAnyFileExtension(label: string): string {
	return label.replace(/\.[a-zA-Z0-9!#\$%&'\(\)\-@\^_`{}~\+,;=\[\]]+$/, '');
}

function getEnvAsRecord(shellIntegrationEnv: { [key: string]: string | undefined } | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	if (shellIntegrationEnv) {
		for (const [key, value] of Object.entries(shellIntegrationEnv)) {
			if (typeof value === 'string') {
				env[key] = value;
			}
		}
	}
	return env;
}
