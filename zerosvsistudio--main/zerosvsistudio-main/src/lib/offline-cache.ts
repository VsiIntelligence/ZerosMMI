import type { ChatAttachment } from "@/lib/chat-attachments";
import type { ZeroMode } from "@/lib/zeros";

export type OfflineChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode?: ZeroMode;
  attachment?: ChatAttachment | null;
};

export type OfflineChatSnapshotInput = {
  scope: string;
  conversationId: string | null;
  conversations: { id: string; title: string }[];
  messages: OfflineChatMessage[];
};

type StoredMessage = OfflineChatMessage & { offlineImageKey?: string };
type StoredSnapshot = {
  scope: string;
  updatedAt: number;
  conversationId: string | null;
  conversations: { id: string; title: string }[];
  messages: StoredMessage[];
  images: Record<string, Blob>;
};

const DB_NAME = "zeros-offline-cache-v1";
const STORE = "snapshots";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Offline storage is unavailable.")); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "scope" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline storage."));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage request failed."));
  });
}

async function readStored(scope: string): Promise<StoredSnapshot | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readonly");
    return (await requestValue(tx.objectStore(STORE).get(scope) as IDBRequest<StoredSnapshot | undefined>)) ?? null;
  } finally { db.close(); }
}

/** Reads this account’s last saved chat and recreates local object URLs for cached image blobs. */
export async function loadOfflineSnapshot(scope: string): Promise<OfflineChatSnapshotInput | null> {
  const row = await readStored(scope);
  if (!row) return null;
  const messages = row.messages.map((stored) => {
    const { offlineImageKey, ...message } = stored;
    let attachment = message.attachment ?? null;
    if (attachment?.kind === "image" && offlineImageKey) {
      const blob = row.images?.[offlineImageKey];
      if (blob) attachment = { ...attachment, src: URL.createObjectURL(blob) };
    }
    return { ...message, attachment };
  });
  return { scope: row.scope, conversationId: row.conversationId, conversations: row.conversations ?? [], messages };
}

/** Stores completed results locally. Remote/signed URLs are never treated as durable; image bytes are cached separately. */
export async function saveOfflineSnapshot(input: OfflineChatSnapshotInput): Promise<void> {
  const previous = await readStored(input.scope).catch(() => null);
  const images: Record<string, Blob> = {};
  const messages: StoredMessage[] = [];
  for (const message of input.messages.slice(-100)) {
    let attachment = message.attachment ?? null;
    let offlineImageKey: string | undefined;
    if (attachment?.kind === "image") {
      const key = input.scope + ":" + message.id;
      let blob: Blob | undefined;
      if (attachment.src) {
        try {
          const response = await fetch(attachment.src);
          if (response.ok) {
            const candidate = await response.blob();
            if (candidate.type.startsWith("image/") && candidate.size <= MAX_IMAGE_BYTES) blob = candidate;
          }
        } catch { /* reuse previously saved image bytes if the device is offline or URL expired */ }
      }
      blob = blob ?? previous?.images?.[key];
      if (blob) { images[key] = blob; offlineImageKey = key; }
      attachment = { ...attachment, src: "" };
    }
    messages.push({ ...message, attachment, ...(offlineImageKey ? { offlineImageKey } : {}) });
  }
  const row: StoredSnapshot = {
    scope: input.scope, updatedAt: Date.now(), conversationId: input.conversationId,
    conversations: input.conversations.slice(0, 100), messages, images,
  };
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save offline result."));
      tx.onabort = () => reject(tx.error ?? new Error("Offline save was aborted."));
    });
  } finally { db.close(); }
}
