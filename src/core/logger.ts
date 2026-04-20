/**
 * Rotating file logger. Writes to data/logs/phantom.log.
 * Rotates to phantom.log.1 when the file exceeds MAX_SIZE_BYTES.
 * Designed to never throw - logging must not crash the main process.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

type LogLevel = "ERROR" | "WARN" | "INFO";

export class Logger {
	private path: string;
	private ready = false;

	constructor(logPath: string) {
		this.path = resolve(logPath);
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			this.ready = true;
		} catch {
			// Can't create log directory - silently degrade
		}
	}

	error(tag: string, message: string): void {
		this.write("ERROR", tag, message);
	}

	warn(tag: string, message: string): void {
		this.write("WARN", tag, message);
	}

	info(tag: string, message: string): void {
		this.write("INFO", tag, message);
	}

	getPath(): string {
		return this.path;
	}

	private write(level: LogLevel, tag: string, message: string): void {
		if (!this.ready) return;
		try {
			this.maybeRotate();
			const line = `${new Date().toISOString()} [${level}] [${tag}] ${message}\n`;
			appendFileSync(this.path, line, "utf-8");
		} catch {
			// Silently degrade
		}
	}

	private maybeRotate(): void {
		try {
			if (!existsSync(this.path)) return;
			const { size } = statSync(this.path);
			if (size >= MAX_SIZE_BYTES) {
				renameSync(this.path, `${this.path}.1`);
			}
		} catch {
			// Ignore rotation errors
		}
	}
}

export const logger = new Logger("data/logs/phantom.log");
