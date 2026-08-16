import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredContextBundle } from "./context-packet";

const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKET_ID = /^[a-z0-9][a-z0-9-]*$/;

function validContextId(value: string): boolean { return CONTEXT_ID.test(value); }
function validPacketId(value: string): boolean { return PACKET_ID.test(value); }
function bundlePath(root: string, contextId: string): string {
  if (!validContextId(contextId)) throw new Error("Invalid context ID. Rerun the original gather request.");
  return path.join(root, "contexts", contextId, "bundle.json");
}

export async function writeContextBundle(root: string, bundle: StoredContextBundle): Promise<string> {
  const target = bundlePath(root, bundle.contextId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(bundle, null, 2), "utf8");
  await rename(temporary, target);
  return target;
}

export async function readContextBundle(root: string, contextId: string): Promise<StoredContextBundle> {
  const target = bundlePath(root, contextId);
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as StoredContextBundle;
    if (value.version !== 1 || value.contextId !== contextId || !Array.isArray(value.packets)) throw new Error("invalid bundle");
    return value;
  } catch {
    throw new Error("Context bundle is unavailable or corrupt. Rerun the original gather request.");
  }
}

export async function readContextPacket(root: string, contextId: string, packetId: string): Promise<string> {
  if (!validPacketId(packetId)) throw new Error("Invalid packet ID. Rerun the original gather request.");
  const bundle = await readContextBundle(root, contextId);
  const packet = bundle.packets.find((item) => item.id === packetId);
  if (!packet) throw new Error("Context packet is unavailable. Rerun the original gather request.");
  return packet.text;
}
