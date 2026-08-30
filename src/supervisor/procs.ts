import fs from "node:fs";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  type AbsPath,
  type ForeignPid,
  type OwnedPid,
  type PortObserved,
  LOOPBACK,
} from "../domain/types.ts";
import { parseAbsPath, type BoxPaths } from "./paths.ts";

export type FsDeps = {
  read(path: AbsPath): string | undefined;
  write(path: AbsPath, body: string, mode?: number): void;
  copy(from: AbsPath, to: AbsPath): void;
  remove(path: AbsPath): void;
  exists(path: AbsPath): boolean;
  mkdirp(path: AbsPath): void;
};

export type ProcDeps = {
  port(host: string, port: number): Promise<boolean>;
  readPidFile(path: AbsPath): number | undefined;
  pidAlive(pid: number): boolean;
  start(input: {
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
    log: AbsPath;
    pidFile: AbsPath;
  }): OwnedPid;
  stop(pid: OwnedPid): void;
  hostPids(hostMain: AbsPath): OwnedPid[];
  opengrokHopPids(): OwnedPid[];
  term(pid: OwnedPid): void;
  syntaxCheck(file: AbsPath): { ok: true } | { ok: false; stderr: string };
};

export function parseOwnedPid(raw: number): OwnedPid {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error("OpenBot: pid is not a positive integer");
  }
  return raw as OwnedPid;
}

export function parseForeignPid(raw: number): ForeignPid {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error("OpenBot: pid is not a positive integer");
  }
  return raw as ForeignPid;
}

export function nodeFs(): FsDeps {
  return {
    read(path) {
      try {
        return fs.readFileSync(path, "utf8");
      } catch (err) {
        if (isEnoent(err)) {
          return undefined;
        }
        throw err;
      }
    },
    write(path, body, mode = 0o644) {
      fs.writeFileSync(path, body, { encoding: "utf8", mode });
    },
    copy(from, to) {
      fs.copyFileSync(from, to);
    },
    remove(path) {
      try {
        fs.unlinkSync(path);
      } catch (err) {
        if (!isEnoent(err)) {
          throw err;
        }
      }
    },
    exists(path) {
      return fs.existsSync(path);
    },
    mkdirp(path) {
      fs.mkdirSync(path, { recursive: true });
    },
  };
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

export function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(250);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function classifyPort(input: {
  listening: boolean;
  pidFile: number | undefined;
  pidAlive: boolean;
  host: string;
  port: number;
}): PortObserved {
  if (!input.listening) {
    return { kind: "absent" };
  }
  if (input.pidFile !== undefined && input.pidAlive) {
    return {
      kind: "ours",
      pid: parseOwnedPid(input.pidFile),
      host: LOOPBACK,
      port: input.port,
    };
  }
  return {
    kind: "foreign",
    pid: parseForeignPid(input.pidFile ?? 1),
    host: input.host,
    port: input.port,
  };
}

export function isHostMainArgv(args: string, hostMain: string, selfPid: number, pid: number): boolean {
  if (pid === selfPid) {
    return false;
  }
  if (/\b(zsh|bash|sh|dash)\b/.test(args) && args.includes(" -c ")) {
    return false;
  }
  const tokens = args.trim().split(/\s+/u);
  const hasNode = tokens.some((token) => /(^|\/)node$/.test(token));
  const hasHost = tokens.some((token) => token === hostMain);
  return hasNode && hasHost;
}

export function isOpengrokHopArgv(args: string, selfPid: number, pid: number): boolean {
  if (pid === selfPid) {
    return false;
  }
  if (/\b(zsh|bash|sh|dash)\b/.test(args) && args.includes(" -c ")) {
    return false;
  }
  const tokens = args.trim().split(/\s+/u);
  const hasPy = tokens.some((token) => /(^|\/)python(\d+(\.\d+)*)?$/.test(token));
  const hasHop = tokens.some((token) => token.endsWith("hop-server.py"));
  return hasPy && hasHop;
}

function eachPsLine(visit: (pid: number, args: string) => void): void {
  const result = spawnSync("ps", ["-ax", "-o", "pid=,args="], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) {
    return;
  }
  for (const line of (result.stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const splitAt = trimmed.search(/\s/u);
    if (splitAt < 0) {
      continue;
    }
    const pid = Number(trimmed.slice(0, splitAt));
    const args = trimmed.slice(splitAt + 1).trim();
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    visit(pid, args);
  }
}

export function nodeProcs(): ProcDeps {
  return {
    port: portOpen,
    readPidFile(path) {
      try {
        const raw = fs.readFileSync(path, "utf8").trim();
        const pid = Number(raw);
        if (!Number.isInteger(pid) || pid <= 0) {
          return undefined;
        }
        return pid;
      } catch (err) {
        if (isEnoent(err)) {
          return undefined;
        }
        throw err;
      }
    },
    pidAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    start(input) {
      const logFd = fs.openSync(input.log, "a");
      const child = spawn(process.execPath, [...input.argv], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, ...input.env },
      });
      fs.closeSync(logFd);
      if (child.pid === undefined) {
        throw new Error("OpenBot: spawn returned no pid");
      }
      child.unref();
      const pid = parseOwnedPid(child.pid);
      fs.writeFileSync(input.pidFile, `${String(pid)}\n`, { encoding: "utf8", mode: 0o644 });
      return pid;
    },
    stop(pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    },
    hostPids(hostMain) {
      const pids: OwnedPid[] = [];
      eachPsLine((pid, args) => {
        if (isHostMainArgv(args, hostMain, process.pid, pid)) {
          pids.push(parseOwnedPid(pid));
        }
      });
      return pids;
    },
    opengrokHopPids() {
      const pids: OwnedPid[] = [];
      eachPsLine((pid, args) => {
        if (isOpengrokHopArgv(args, process.pid, pid)) {
          pids.push(parseOwnedPid(pid));
        }
      });
      return pids;
    },
    term(pid) {
      process.kill(pid, "SIGTERM");
    },
    syntaxCheck(file) {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (result.status === 0) {
        return { ok: true };
      }
      return { ok: false, stderr: result.stderr || result.stdout || "node --check failed" };
    },
  };
}

export function writeTemp(fsDeps: FsDeps, dir: AbsPath, name: string, body: string): AbsPath {
  const path = parseAbsPath(`${dir.replace(/\/$/u, "")}/${name}`);
  fsDeps.write(path, body, 0o644);
  return path;
}

export type { BoxPaths };
