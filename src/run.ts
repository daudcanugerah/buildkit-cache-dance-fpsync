import spawnPlease from 'spawn-please'
import cp, { type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { isPathWithinWorkspace } from './opts.js';

// Global debug flag - set by setDebugMode()
let debugMode = false;

export function setDebugMode(enabled: boolean) {
    debugMode = enabled;
}

export function debug(message: string) {
    if (debugMode) {
        console.log(`[DEBUG] ${message}`);
    }
}

export function debugSection(title: string) {
    if (debugMode) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[DEBUG] ${title}`);
        console.log(`${'='.repeat(60)}`);
    }
}

export async function run(command: string, args: string[], options?: { captureOutput?: boolean }) {
    const cmdString = `${command} ${args.join(' ')}`;
    if (debugMode) {
        debug(`Executing: ${cmdString}`);
    }
    try {
        // spawn-please resolves { stdout, stderr }
        const output = await spawnPlease(command, args);
        if (debugMode && options?.captureOutput && output) {
            const text = output.stdout?.toString() ?? '';
            debug(`Output: ${text.substring(0, 500)}${text.length > 500 ? '...(truncated)' : ''}`);
        }
        return output;
    } catch (error) {
        console.error(`Error running command: ${cmdString}`);
        if (debugMode && error instanceof Error) {
            debug(`Error details: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Debug utility to inspect a directory's contents
 * Returns the size in bytes for comparison purposes
 * Security: Only allows inspection of paths within the workspace to prevent information disclosure
 */
export async function debugInspectDirectory(dirPath: string, label: string): Promise<string | null> {
    if (!debugMode) return null;

    debugSection(`Directory Inspection: ${label}`);
    debug(`Path: ${dirPath}`);

    // Security: Only allow inspection within workspace
    const workspaceRoot = process.env.GITHUB_WORKSPACE || process.cwd();
    const resolvedPath = path.resolve(dirPath);
    if (!isPathWithinWorkspace(resolvedPath, workspaceRoot)) {
        debug(`  -> SKIPPED: Path is outside workspace (security restriction)`);
        return null;
    }

    let sizeStr: string | null = null;

    try {
        const stats = await fs.stat(dirPath);
        if (!stats.isDirectory()) {
            debug(`  -> Not a directory`);
            return null;
        }

        // Get directory size using du -sh
        try {
            const duOutput = await spawnPlease('du', ['-sh', dirPath]);
            sizeStr = duOutput.stdout.trim();
            debug(`Size: ${sizeStr}`);
        } catch {
            debug(`Size: (unable to determine)`);
        }

        // List files
        try {
            const files = await fs.readdir(dirPath, { withFileTypes: true });
            debug(`Contents (${files.length} items):`);
            for (const file of files.slice(0, 20)) {
                const type = file.isDirectory() ? '[DIR]' : '[FILE]';
                debug(`  ${type} ${file.name}`);
            }
            if (files.length > 20) {
                debug(`  ... and ${files.length - 20} more items`);
            }
        } catch {
            debug(`Contents: (unable to list)`);
        }

        // Find files recursively (limited)
        try {
            const findOutput = await spawnPlease('find', [dirPath, '-maxdepth', '3', '-type', 'f']);
            const fileList = findOutput.stdout.trim().split('\n').filter(f => f);
            debug(`Files (recursive, max depth 3): ${fileList.length} files found`);
            for (const f of fileList.slice(0, 10)) {
                debug(`  ${f}`);
            }
            if (fileList.length > 10) {
                debug(`  ... and ${fileList.length - 10} more files`);
            }
        } catch {
            // Ignore find errors
        }
    } catch (error) {
        debug(`  -> Directory does not exist or is not accessible`);
    }

    return sizeStr;
}

/**
 * Compare before/after sizes and log the difference
 */
export function debugSizeComparison(beforeSize: string | null, afterSize: string | null, label: string) {
    if (!debugMode) return;

    debugSection(`Size Comparison: ${label}`);
    debug(`Before: ${beforeSize || '(not available)'}`);
    debug(`After:  ${afterSize || '(not available)'}`);

    if (beforeSize && afterSize) {
        // Extract numeric values for comparison hint
        const beforeMatch = beforeSize.match(/^([\d.]+)([KMGT]?)/i);
        const afterMatch = afterSize.match(/^([\d.]+)([KMGT]?)/i);
        if (beforeMatch && afterMatch) {
            debug(`  -> Compare these values to verify cache extraction worked`);
            if (beforeSize === afterSize) {
                debug(`  -> WARNING: Sizes are identical - cache may not have been extracted!`);
            }
        }
    }
}

export async function runPiped([command1, args1]: [string, string[]], [command2, args2]: [string, string[]]) {
    const cp1 = cp.spawn(command1, args1, { stdio: ['inherit', 'pipe', 'inherit'] });
    const cp2 = cp.spawn(command2, args2, { stdio: ['pipe', 'inherit', 'inherit'] });

    cp1.stdout.pipe(cp2.stdin);

    await Promise.all([assertSuccess(cp1), assertSuccess(cp2)]);
}

function assertSuccess(cp: ChildProcess) {
    return new Promise<void>((resolve, reject) => {
        cp.on('error', (error) => {
            reject(error);
        });
        cp.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`process exited with code ${code}`));
            }
            resolve();
        });
    });
}
