import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownPre } from "@/components/CodeBlock";
import { onAuthStateChanged, type User as FirebaseUser } from "firebase/auth";
import {
  ArrowUp, Boxes, Brain, Code2, Film, Globe, Image as ImageIcon, LogOut, Menu,
  Music4, Pencil, Plus, Sparkles, Trash2, X,
} from "lucide-react";

import Wallpaper from "@/components/Wallpaper";
import ZerosControls from "@/components/ZerosControls";
import SettingsButton from "@/components/SettingsDialog";
import { AppChips, ActionProposalCard } from "@/components/AppActions";
import { takeChatMeta } from "@/lib/chat-meta";
import BillingGate from "@/components/BillingGate";
import DialogHost from "@/components/DialogHost";
import ReturnHandlers from "@/components/ReturnHandlers";
import Toaster from "@/components/Toaster";
import { confirmDialog, promptDialog } from "@/lib/dialogs";
import { formatChatError } from "@/lib/chat-errors";
import ModelViewer from "@/components/ModelViewer";
import WebPreview from "@/components/WebPreview";
import ZerosOrb from "@/components/ZerosOrb";
import ThinkingTrace from "@/components/ThinkingTrace";
import { supabase } from "@/integrations/supabase/client";
import { firebaseAuth, signOutFirebase } from "@/lib/firebase";
import { generateImageDetailed, imageForEdit, streamChat, type Msg } from "@/lib/ai-client";
import { pickTarget, rememberedArtifacts, wantsEdit } from "@/lib/artifact-memory";
import { type ZeroMode } from "@/lib/zeros";
import { liteInfo, renderSongDetailed, type SongSpec } from "@/lib/song";
import { songReport } from "@/lib/song-report";
import { buildSong } from "@/lib/run-song";
import { streamCommentary } from "@/lib/commentary";
import { uploadChatAsset, deleteConversationAssets } from "@/lib/chat-assets";
import {
  hydrateAttachments, persistSongAssets, persistVideoAssets, persistWebAssets, type ChatAttachment,
} from "@/lib/chat-attachments";
import { buildWebsite, type WebBuildResult } from "@/lib/run-web-build";
import { liteReport } from "@/lib/site-verifier";
import { quip } from "@/lib/zeros-voice";
import { buildModel } from "@/lib/run-model-forge";
import ForgeViewer, { primeForgeCache } from "@/components/ForgeViewer";
import {
  addMemories, clearMemories, deleteMemory, forgetMemories, learnFromTurn, loadMemories,
  setMemoryEnabled, type MemoryItem,
} from "@/lib/memory";
import { useAccountSettings } from "@/lib/account-settings";
import { detectExplicitForget, detectExplicitRemember, detectForgetAll, factsForPrompt } from "@/lib/memory-utils";
import { SongBlock, type SongStem, type SongUrls } from "@/routes/song-block";
import { VideoPreview } from "@/components/VideoPreview";
import { buildVideo, type VideoBuild } from "@/lib/run-video-build";
import { renderVideoWithMeta } from "@/lib/render-video";
import {
  formatZerosDataError, loadConversationsList, loadMessagesForConversation,
} from "@/lib/load-conversations";
import { loadOfflineSnapshot, saveOfflineSnapshot } from "@/lib/offline-cache";

type Attachment = ChatAttachment;
type ChatMessage = {
  id: string; role: "user" | "assistant"; content: string; mode?: ZeroMode; attachment?: Attachment | null;
};

const MODES: { id: Exclude<ZeroMode, "chat">; label: string; Icon: typeof Globe }[] = [
  { id: "search", label: "Web", Icon: Globe },
  { id: "image", label: "Image", Icon: ImageIcon },
  { id: "model", label: "3D Model", Icon: Boxes },
  { id: "music", label: "Song", Icon: Music4 },
  { id: "web", label: "Code", Icon: Code2 },
  { id: "video", label: "Video", Icon: Film },
];

const SUGGESTIONS: { text: string; Icon: typeof Globe; mode: ZeroMode }[] = [
  { text: "What's new in AI today", Icon: Globe, mode: "search" },
  { text: "Render a 3D glass orb", Icon: ImageIcon, mode: "image" },
  { text: "Build a 3D sports car", Icon: Boxes, mode: "model" },
  { text: "Write me a song", Icon: Music4, mode: "music" },
  { text: "Build a mini web app", Icon: Code2, mode: "web" },
  { text: "Make a cinematic video", Icon: Film, mode: "video" },
  { text: "Roast my startup idea", Icon: Sparkles, mode: "chat" },
];

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

/** Coalesces rapid streaming updates into one React state update per animation frame (smooth typing, no wasted renders). */
function frameThrottle<T>(apply: (v: T) => void): { push: (v: T) => void; flush: () => void } {
  let pending: { v: T } | null = null, raf = 0;
  const run = (): void => { raf = 0; if (pending) { const { v } = pending; pending = null; apply(v); } };
  return { push: (v) => { pending = { v }; if (!raf) raf = requestAnimationFrame(run); }, flush: () => { if (raf) cancelAnimationFrame(raf); run(); } };
}

export function ChatPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<FirebaseUser | null>(null);
  const [ready, setReady] = useState(false);
  const [accountDataReady, setAccountDataReady] = useState(false);
  const [isGuest, setIsGuest] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ZeroMode>("chat");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [thinkingMode, setThinkingMode] = useState<ZeroMode>("chat");
  const [error, setError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<{ id: string; title: string }[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [songUrls, setSongUrls] = useState<Record<string, SongUrls>>({});
  const [stemBusy, setStemBusy] = useState<Record<string, SongStem | null>>({});
  const [rebuilding, setRebuilding] = useState<Record<string, boolean>>({});
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({});
  const [videoFormats, setVideoFormats] = useState<Record<string, "mp4" | "webm">>({});
  const [videoAudio, setVideoAudio] = useState<Record<string, boolean>>({});
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const memoryOn = useAccountSettings().memoryEnabled;
  const [memoryOpen, setMemoryOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** monotonic id of the latest 'open a saved chat' request: anything older is ignored, so clicking fast can never show the wrong chat */
  const openSeq = useRef(0);
  const activeUidRef = useRef<string | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const memoriesRef = useRef<MemoryItem[]>(memories);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { memoriesRef.current = memories; }, [memories]);

  // Zeros memory: load the signed-in user's saved facts (guests have none).
  useEffect(() => {
    if (!session) { setMemories([]); return; }
    let cancelled = false;
    void loadMemories(session.uid)
      .then((rows) => { if (!cancelled) setMemories(rows); })
      .catch(() => { /* memory is optional - chat still works */ });
    return () => { cancelled = true; };
  }, [session]);

  // Bring back the last completed result even when Supabase or the network is unavailable.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void loadOfflineSnapshot(session.uid).then((cached) => {
      if (cancelled || !cached || !cached.messages.length) return;
      if (messagesRef.current.length === 0) {
        setMessages(cached.messages as ChatMessage[]);
        setConversationId(cached.conversationId);
        setConversations(cached.conversations);
        setReady(true);
        setAccountDataReady(true);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [session]);

  // Cache idle snapshots only: never replace a completed local result with a streaming placeholder.
  useEffect(() => {
    if (!session || !ready || busy) return;
    void saveOfflineSnapshot({ scope: session.uid, conversationId, conversations, messages }).catch(() => undefined);
  }, [session, ready, busy, conversationId, conversations, messages]);

  const toggleMemory = (on: boolean) => { setMemoryEnabled(on); };
  const removeMemory = async (id: string) => {
    if (!session) return;
    setMemories((prev) => prev.filter((m) => m.id !== id));
    try { await deleteMemory(session.uid, id); } catch { /* ignore */ }
  };
  const wipeMemories = async () => {
    if (!session) return;
    const ok = await confirmDialog({ title: "Clear everything Zeros remembers?", message: "Every saved memory about you is forgotten. This can't be undone.", confirmLabel: "Clear memory", destructive: true });
    if (!ok) return;
    setMemories([]);
    try { await clearMemories(session.uid); } catch { /* ignore */ }
  };

  useEffect(() => {
    const guest = sessionStorage.getItem("zeros_guest") === "1";
    setIsGuest(guest);
    const unsub = onAuthStateChanged(firebaseAuth, (user) => {
      /* A guest tab never gets an account session, even if the same browser signs in from another tab: guest chats are never stored. */
      const nextUid = guest ? null : (user?.uid ?? null);
      if (activeUidRef.current !== nextUid) {
        setMessages([]);
        setConversations([]);
        setConversationId(null);
        activeUidRef.current = nextUid;
      }
      setSession(guest ? null : user);
      if (!user && !guest) navigate({ to: "/" });
      if (!user || guest) { setAccountDataReady(true); setReady(true); }
    });
    return unsub;
  }, [navigate]);

  /**
   * Shows a saved conversation. The text appears at once; images, songs, videos, 3D models and websites arrive as each is ready
   * (bulk-signed, time-boxed, one failure never touches another). A newer request always wins over an older one.
   */
  const restoreConversation = useCallback(async (convId: string): Promise<boolean> => {
    if (!session) return false;
    const seq = ++openSeq.current, current = (): boolean => seq === openSeq.current;
    const rows = await loadMessagesForConversation(session, convId);
    if (!current()) return false;
    setMessages(rows.map((r) => ({ id: r.id, role: r.role as "user" | "assistant", content: r.content, mode: (r.mode as ZeroMode) ?? undefined, attachment: (r.attachment as Attachment | null) ?? null })));
    setConversationId(convId);
    void hydrateAttachments(
      rows.map((r) => ({ id: r.id, attachment: (r.attachment as ChatAttachment | null) ?? null })),
      (id, res) => {
        if (!current()) return;
        if (res.songUrl) setSongUrls((p) => ({ ...p, [id]: { play: res.songUrl! } }));
        if (res.videoUrl) setVideoUrls((p) => ({ ...p, [id]: res.videoUrl! }));
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, attachment: res.attachment as Attachment | null } : m)));
      },
      current,
    );
    return true;
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const convs = await loadConversationsList(session);
        if (cancelled) return;
        setConversations(convs.map((c) => ({ id: c.id, title: c.title ?? "Chat" })));
        const first = convs[0];
        if (first) {
          try { await restoreConversation(first.id); }
          catch (e) {
            /* never wipe the view because one load failed: keep the chat selected and say what happened */
            if (!cancelled) { setConversationId(first.id); setError(`Could not open your latest chat (${formatZerosDataError(e, "unknown")}). Pick it from the list to try again.`); }
          }
        }
      } catch (e) {
        if (!cancelled) setError(`Could not load saved chats (${formatZerosDataError(e, "unknown")}).`);
      } finally {
        if (!cancelled) { setAccountDataReady(true); setReady(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [session, restoreConversation]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth", block: "end" }); }, [messages, busy, status]);

  const persist = useCallback(async (m: ChatMessage, forcedId?: string) => {
    if (!session) return;
    let cid = forcedId ?? conversationId;
    if (!cid) {
      const title = (m.role === "user" ? m.content : "New chat").replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
      const res = await supabase.from("conversations").insert({ user_id: session.uid, title }).select("id, title").single();
      if (res.error || !res.data) {
        setError(`Chat could not be saved. Messages still work in this tab.`);
        return undefined;
      }
      cid = res.data.id;
      setConversationId(res.data.id);
      setConversations((prev) => [{ id: res.data!.id, title: res.data!.title ?? title }, ...prev]);
    }
    const saved = await supabase.from("messages").insert({
      conversation_id: cid, user_id: session.uid, role: m.role, content: m.content, mode: m.mode ?? null, attachment: (m.attachment ?? null) as never,
    });
    if (saved.error) setError("This message could not be synced to your account (it is still safe in this tab).");
    try { await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", cid).eq("user_id", session.uid); } catch {}
    return cid;
  }, [session, conversationId]);

  const openConversation = useCallback(async (id: string) => {
    if (!session) return;
    const mine = openSeq.current + 1;
    setSidebar(false);
    setError(null);
    setLoadingChat(true);
    try { await restoreConversation(id); }
    catch (e) { if (openSeq.current + 1 >= mine) setError(`Could not open chat (${formatZerosDataError(e, "unknown")}).`); }
    finally { if (openSeq.current <= mine) setLoadingChat(false); }
  }, [session, restoreConversation]);

  const renameConversation = useCallback(async (id: string, currentTitle: string) => {
    if (!session) return;
    const next = (await promptDialog({ title: "Rename chat", initial: currentTitle, confirmLabel: "Rename", maxLength: 80 }))?.trim();
    if (!next || next === currentTitle) return;
    try {
      const { error } = await supabase
        .from("conversations")
        .update({ title: next.slice(0, 80) })
        .eq("id", id)
        .eq("user_id", session.uid);
      if (error) throw error;
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: next.slice(0, 80) } : c)));
    } catch (e) {
      setError(`Could not rename chat (${formatZerosDataError(e, "unknown")}).`);
    }
  }, [session]);

  const deleteConversation = useCallback(async (id: string) => {
    if (!session) return;
    const ok = await confirmDialog({ title: "Delete this chat?", message: "The chat and everything Zeros made in it are removed for good.", confirmLabel: "Delete", destructive: true });
    if (!ok) return;
    try {
      await deleteConversationAssets(session.uid, id);   /* songs, videos, images, site archives: gone with the chat, not orphaned in storage */
      await supabase.from("messages").delete().eq("conversation_id", id);
      const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", id)
        .eq("user_id", session.uid);
      if (error) throw error;
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) {
        setConversationId(null);
        setMessages([]);
      }
    } catch (e) {
      setError(`Could not delete chat (${formatZerosDataError(e, "unknown")}).`);
    }
  }, [session, conversationId]);

  const send = async (override?: string, forcedMode?: ZeroMode) => {
    const requestMode = forcedMode ?? mode;
    const prompt = (override ?? input).trim();
    if (!prompt || busy || (session && !accountDataReady)) return;
    setInput(""); setError(null); setBusy(true); setThinkingMode(requestMode);
    setStatus(requestMode === "model" ? "Sculpting…" : "Thinking…");
    const userMsg: ChatMessage = { id: uid(), role: "user", content: prompt, mode: requestMode };
    const assistantId = uid();
    try {
      setMessages((prev) => [...prev, userMsg]);
      const convPromise = persist(userMsg);   /* saved in the background so the message shows instantly */
      const showAssistant = (msg: ChatMessage) => setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev.map((x) => (x.id === msg.id ? msg : x)) : [...prev, msg]));
      const cacheArtifactLocally = async (msg: ChatMessage, cid?: string) => {
        if (!session) return;
        const prior = messagesRef.current.filter((x) => x.id !== msg.id);
        if (!prior.some((x) => x.id === userMsg.id)) prior.push(userMsg);
        prior.push(msg);
        try {
          await saveOfflineSnapshot({ scope: session.uid, conversationId: cid ?? conversationId, conversations, messages: prior });
        } catch { /* local storage is optional and must not fail a generated result */ }
      };
      const personalFacts = (): string[] => (session && memoryOn ? factsForPrompt(memoriesRef.current.map((x) => x.fact)) : []);
      /** Zeros' long, witty, reasoned write-up of what it just built; streams into the message. */
      const commentate = (cm: "image" | "model" | "music" | "web" | "video", facts: string[], warnings: string[], base: ChatMessage): Promise<string> => {
        setStatus("Writing up what I built…");
        return streamCommentary({ mode: cm, request: prompt, facts, warnings, memories: personalFacts(), streamChat, onDelta: (t) => showAssistant({ ...base, content: t }) });
      };

      if (requestMode === "image") {
        // "make it night" after a picture changes THAT picture. The earlier picture is found by what it shows, and a request that starts
        // a new subject ("draw a blue car") is never treated as an edit.
        const imageTarget = pickTarget(rememberedArtifacts(messagesRef.current, "image"), prompt);
        const editing = wantsEdit(prompt, !!imageTarget);
        const editedImage = editing && imageTarget?.attachment.kind === "image" ? imageTarget.attachment : null;
        const editBase = editedImage?.src ? await imageForEdit(editedImage.src) : null;
        const made = await generateImageDetailed(prompt, editedImage ? { previousPrompt: editedImage.prompt, base: editBase } : {});
        const src = made.src;
        const activeConversationId = (await convPromise.catch(() => undefined)) ?? conversationId ?? undefined;
        let storagePath: string | undefined;
        if (session && activeConversationId) {
          try {
            const blob = await fetch(src).then((r) => r.blob());
            storagePath = (await uploadChatAsset(session.uid, activeConversationId, blob, "generated-image.png")).storagePath;
          } catch { /* storage is optional: the image still shows */ }
        }
        const base: ChatMessage = { id: assistantId, role: "assistant", content: quip("image", prompt), mode: requestMode, attachment: { kind: "image", src, prompt: made.prompt, ...(made.drawn ? { drawn: true } : {}), ...(storagePath ? { storagePath } : {}) } };
        showAssistant(base);
        await cacheArtifactLocally(base, activeConversationId);
        const text = await commentate("image", [`Prompt: "${prompt.slice(0, 200)}"`, ...(editing ? ["This changes the previous picture; everything the change does not touch is kept"] : ["Zeros enhanced the prompt (composition, light, palette) before rendering it"]), ...(made.drawn ? ["No picture model was reachable, so this picture was drawn as a vector illustration"] : []), "Delivered as a full-resolution PNG you can download from the image"], [], base).catch(() => base.content);
        const finalImage = { ...base, content: text };
        showAssistant(finalImage);
        await persist(finalImage, activeConversationId ?? undefined).catch(() => undefined);
        return;
      }

      if (requestMode === "model") {
        const modelTarget = pickTarget(rememberedArtifacts(messagesRef.current, "model"), prompt);
        const modelEdit = wantsEdit(prompt, !!modelTarget) && modelTarget?.attachment.kind === "forge" ? modelTarget.attachment : null;
        const built = await buildModel({
          prompt,
          previousCode: modelEdit ? modelEdit.code : null,
          memories: personalFacts(),
          streamChat,
          onStatus: setStatus,
        });
        primeForgeCache(built.code, built.mesh);
        const activeConversationId = (await convPromise.catch(() => undefined)) ?? conversationId ?? undefined;
        const base: ChatMessage = {
          id: assistantId, role: "assistant", mode: requestMode,
          content: built.witty || quip("model", prompt),
          attachment: { kind: "forge", code: built.code, prompt, stats: built.stats, quality: built.quality, ...(built.review ? { score: built.review.score } : {}) },
        };
        showAssistant(base);
        await cacheArtifactLocally(base, activeConversationId);
        const text = await commentate("model", built.facts, built.warnings, base).catch(() => base.content);
        const finalModel = { ...base, content: text };
        showAssistant(finalModel);
        await persist(finalModel, activeConversationId ?? undefined).catch(() => undefined);
        return;
      }

      // ---- Zeros memory: explicit "remember / forget" commands are applied before the model answers ----
      let memoryFacts: string[] = [];
      let memoryNote = "";
      if (session && memoryOn) {
        let list = memoriesRef.current;
        try {
          if (detectForgetAll(prompt)) {
            await clearMemories(session.uid);
            list = [];
            memoryNote = "all saved memories were just deleted";
          } else {
            const forgetNeedle = detectExplicitForget(prompt);
            if (forgetNeedle) {
              const before = list.length;
              list = await forgetMemories(session.uid, [forgetNeedle], list);
              memoryNote = list.length < before ? "the matching memory was just removed" : "no stored memory matched, nothing was removed";
            }
            const remember = detectExplicitRemember(prompt);
            if (remember) {
              list = await addMemories(session.uid, [remember], list);
              memoryNote = "the fact was just saved to long-term memory";
            }
          }
          if (list !== memoriesRef.current) setMemories(list);
        } catch { /* memory must never block chatting */ }
        memoryFacts = factsForPrompt(list.map((m) => m.fact));
      }

      const history: Msg[] = [...messagesRef.current.filter((m) => m.id !== assistantId), userMsg]
        .filter((m) => (m.content || "").trim().length > 0)
        .slice(-20)
        .map((m) => ({
          role: m.role,
          content: m.content.length > 12000 ? m.content.slice(0, 12000) + "\n…[truncated]" : m.content,
        }));
      if (memoryNote && history.length) {
        const last = history[history.length - 1]!;
        history[history.length - 1] = { ...last, content: `${last.content}\n\n(app note, not from the user: ${memoryNote})` };
      }
      if (requestMode === "music") {
        showAssistant({ id: assistantId, role: "assistant", content: "", mode: requestMode });
        // "make the chorus bigger" after a song revises that song (its complete spec is carried forward).
        const songTarget = pickTarget(rememberedArtifacts(messagesRef.current, "song"), prompt);
        const songEdit = wantsEdit(prompt, !!songTarget) && songTarget?.attachment.kind === "song" ? songTarget.attachment.spec : null;
        const built = await buildSong({ prompt, history, memories: memoryFacts, streamChat, onStatus: setStatus, onProgress: () => {}, ...(songEdit ? { previous: songEdit } : {}) });
        const wavUrl = URL.createObjectURL(built.render.blob);
        const opusUrl = built.render.compressed ? URL.createObjectURL(built.render.compressed) : undefined;
        setSongUrls((p) => ({ ...p, [assistantId]: { play: wavUrl, wav: wavUrl, ...(opusUrl ? { opus: opusUrl } : {}) } }));
        const activeConversationId = await convPromise;
        let storagePath: string | undefined;
        if (session && activeConversationId) {
          setStatus("Saving the track to your account…");
          storagePath = (await persistSongAssets(session.uid, activeConversationId, built.render.compressed ?? built.render.blob, built.spec.title || "zeros-song")).storagePath;
        }
        const attachment: ChatAttachment = { kind: "song", spec: built.spec, info: built.lite, report: built.report, ...(storagePath ? { storagePath } : {}) };
        const base: ChatMessage = { id: assistantId, role: "assistant", mode: requestMode, content: built.witty || quip("music", prompt), attachment };
        showAssistant(base);
        const text = await commentate("music", built.facts, built.warnings, base);
        const finalSong = { ...base, content: text };
        showAssistant(finalSong);
        await persist(finalSong, activeConversationId ?? undefined);
        return;
      }
      setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", mode: requestMode }]);
      let webBuild: WebBuildResult | null = null;
      let videoBuild: VideoBuild | null = null;
      let videoResult: Awaited<ReturnType<typeof renderVideoWithMeta>> | null = null;
      let renderFailure = "";
      let full = "";
      if (requestMode === "web") {
        const siteTarget = pickTarget(rememberedArtifacts(messagesRef.current, "web"), prompt);
        const siteEdit = wantsEdit(prompt, !!siteTarget) && siteTarget?.attachment.kind === "web" ? siteTarget.attachment.project : null;
        webBuild = await buildWebsite({
          prompt,
          history,
          previous: siteEdit,
          memories: memoryFacts,
          streamChat,
          onStatus: (s) => setStatus(s),
        });
        full = webBuild.witty;
      } else if (requestMode === "video") {
        // "make scene 2 darker" after a film revises that film (its complete script is carried forward).
        const filmTarget = pickTarget(rememberedArtifacts(messagesRef.current, "video"), prompt);
        const filmEdit = wantsEdit(prompt, !!filmTarget) && filmTarget?.attachment.kind === "video" ? filmTarget.attachment.spec : null;
        videoBuild = await buildVideo({ prompt, history, memories: memoryFacts, streamChat, onStatus: (s2) => setStatus(s2), ...(filmEdit ? { previous: filmEdit } : {}) });
        full = videoBuild.witty;
      } else {
        const stream = frameThrottle<string>((text) => setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: text } : m))));
        full = await streamChat(history, requestMode, memoryFacts, stream.push);
        stream.flush();
      }
      let attachment: Attachment | null = null;
      let content = full;

      if (requestMode === "web" && webBuild) {
        const activeConversationId = await convPromise;
        const project = webBuild.project;
        let webStoragePath: string | undefined;
        if (session && activeConversationId) {
          try { webStoragePath = (await persistWebAssets(session.uid, activeConversationId, project)).storagePath; } catch { /* storage is optional */ }
        }
        attachment = {
          kind: "web",
          project,
          brief: prompt,
          ...(webBuild.report || webBuild.lint ? { report: { ...(webBuild.report ? liteReport(webBuild.report) : { ok: true, checkedAt: new Date().toISOString(), pagesChecked: 0, headline: "Static checks passed", issues: [] }), ...(webBuild.lint ? { checks: webBuild.lint.checks } : {}), ...(webBuild.notes.length ? { notes: webBuild.notes } : {}) } } : {}),
          ...(webStoragePath ? { storagePath: webStoragePath } : {}),
        };
        const pageCount = Object.keys(project.files).filter((f) => /\.html?$/i.test(f)).length;
        const fixed = webBuild.repairRounds > 0 ? ` Zeros caught problems and fixed them in ${webBuild.repairRounds} round${webBuild.repairRounds === 1 ? "" : "s"} 🔧.` : "";
        const verdict = webBuild.report ? `\n\n${webBuild.report.ok ? "✅" : "⚠️"} ${webBuild.report.headline}${fixed}` : "";
        const statsLine = `**${Object.keys(project.files).length} files · ${pageCount} pages**${verdict}`;
        const webBase: ChatMessage = { id: assistantId, role: "assistant", mode: requestMode, content: full || quip("web", prompt), attachment };
        showAssistant(webBase);
        const webFacts = [
          `${Object.keys(project.files).length} real files: ${Object.keys(project.files).slice(0, 14).join(", ")}`,
          `${pageCount} HTML pages with shared navigation, one design system and one stylesheet set`,
          ...(webBuild.report ? [`Verification: ${webBuild.report.headline}`] : ["Verification report unavailable on this run"]),
          ...(webBuild.repairRounds > 0 ? [`Zeros caught problems and repaired them in ${webBuild.repairRounds} round(s) before delivering`] : ["No repair round was needed"]),
        ];
        const webText = await commentate("web", webFacts, [], webBase);
        content = `${webText}\n\n${statsLine}`;
      } else if (requestMode === "video" && videoBuild) {
        const activeConversationId = await convPromise;
        const quality = /\b(1080p?|4k|full\s?hd|cinema(tic)? quality|high quality|hd)\b/i.test(prompt) ? "cinema" : "standard";
        content = videoBuild.witty || quip("video", prompt);
        attachment = { kind: "video", spec: videoBuild.spec };
        try {
          let stage = "Preparing the shoot…";
          const result = await renderVideoWithMeta(
            videoBuild.spec,
            (ratio) => setStatus(`${stage} ${Math.round(ratio * 100)}%`),
            (s2) => { stage = s2.replace(/…$/, ""); setStatus(`${stage}…`); },
            { quality },
          );
          videoResult = result;
          setVideoAudio((p) => ({ ...p, [assistantId]: !!result.audio }));
          const url = URL.createObjectURL(result.blob);
          setVideoUrls((p) => ({ ...p, [assistantId]: url }));
          setVideoFormats((p) => ({ ...p, [assistantId]: result.ext }));
          attachment = { kind: "video", spec: result.spec, format: result.ext, audio: !!result.audio, report: result.report, vtt: result.vtt };
          const readyMsg: ChatMessage = { id: assistantId, role: "assistant", content, mode: requestMode, attachment };
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? readyMsg : m)));
          if (session && activeConversationId) {
            try {
              const paths = await persistVideoAssets(session.uid, activeConversationId, result.blob, result.spec, result.ext);
              if (paths.storagePath) {
                attachment = { ...attachment, storagePath: paths.storagePath };
                setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...readyMsg, attachment: attachment as Attachment } : m)));
              }
            } catch (upErr) {
              console.warn("[Zeros] video upload failed:", upErr);
            }
          }
        } catch (renderErr) {
          console.warn("[Zeros] video render failed:", renderErr);
          const why = renderErr instanceof Error ? renderErr.message : "unknown error";
          renderFailure = `The film could not be rendered: ${why}. The script is saved above, so ask me to try again.`;
        }
      }

      if (requestMode === "video" && attachment?.kind === "video") {
        const videoBase: ChatMessage = { id: assistantId, role: "assistant", mode: requestMode, content, attachment };
        showAssistant(videoBase);
        const checks = videoResult?.report.checks.map((c) => `${c.ok ? "Verified" : c.note ? "Note" : "Flagged"} - ${c.label}: ${c.value}`) ?? [];
        const warn = [...(videoBuild?.warnings ?? []), ...(renderFailure ? [renderFailure] : [])];
        content = await commentate("video", [...(videoBuild?.facts ?? []), ...(videoResult ? [`Report headline: ${videoResult.report.headline} (score ${videoResult.report.score}/100)`] : []), ...checks], warn, videoBase);
      }
      const activeConversationId = await convPromise;
      const appMeta = takeChatMeta();
      const finalMsg: ChatMessage = { id: assistantId, role: "assistant", content, mode: requestMode, attachment: attachment ?? (appMeta ? { kind: "apps", apps: appMeta.apps, proposal: appMeta.proposal } : null) };
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? finalMsg : m)));
      await persist(finalMsg, activeConversationId ?? undefined);
      if (session && memoryOn && (requestMode === "chat" || requestMode === "search") && !memoryNote) {
        void learnFromTurn(session.uid, prompt, full, memoriesRef.current).then((next) => { if (next) setMemories(next); });
      }
    } catch (e) {
      let msg = formatChatError(e);
      if (/empty generation|incomplete/i.test(msg)) msg = "Generation hit a snag. Please try again.";
      setError(`Message failed: ${msg}`);
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  /** Re-renders a song from its blueprint (deterministic seed): restores playback and the lossless WAV after a reload. */
  const rebuildSong = async (id: string, spec: SongSpec) => {
    setRebuilding((p) => ({ ...p, [id]: true }));
    try {
      const r = await renderSongDetailed(spec, undefined, { compress: false });
      const wav = URL.createObjectURL(r.blob);
      setSongUrls((p) => ({ ...p, [id]: { ...p[id], play: wav, wav } }));
      setMessages((prev) => prev.map((m) => (m.id === id && m.attachment?.kind === "song" && !m.attachment.info ? { ...m, attachment: { ...m.attachment, info: liteInfo(r.info), report: songReport(spec, liteInfo(r.info)) } } : m)));
    } catch (e) {
      setError(`Could not rebuild the audio (${e instanceof Error ? e.message.slice(0, 90) : "error"}).`);
    } finally {
      setRebuilding((p) => ({ ...p, [id]: false }));
    }
  };
  /** Renders the karaoke (no vocals) or acapella (vocals only) version of a finished song on demand. */
  const renderStem = async (id: string, spec: SongSpec, stem: SongStem) => {
    setStemBusy((p) => ({ ...p, [id]: stem }));
    try {
      const r = await renderSongDetailed(spec, undefined, { compress: false, stem });
      const url = URL.createObjectURL(r.blob);
      setSongUrls((p) => ({ ...p, [id]: { play: p[id]?.play ?? url, ...p[id], [stem]: url } }));
    } catch (e) {
      setError(`Could not render the ${stem === "vocals" ? "acapella" : "karaoke"} version (${e instanceof Error ? e.message.slice(0, 90) : "error"}).`);
    } finally {
      setStemBusy((p) => ({ ...p, [id]: null }));
    }
  };

  if (!ready) {
    return (
      <div className="relative flex min-h-screen items-center justify-center text-white">
        <Wallpaper />
        <p className="relative z-10 text-white/70">Loading…</p>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen text-white">
      <Wallpaper />
      <div className="relative z-10 mx-auto flex min-h-screen max-w-3xl flex-col px-3 pb-36 pt-4">
        <div className="mb-3 flex items-center justify-between rounded-full border border-white/10 bg-black/55 px-3 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => setSidebar(true)} className="grid h-9 w-9 place-items-center rounded-full text-white/90" aria-label="Open sidebar">
              <Menu className="h-5 w-5" />
            </button>
            <p className="text-[17px] font-semibold tracking-tight text-white">Zeros</p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full border border-white/12 bg-black/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/85">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            {isGuest || !session ? "Guest" : "Account"}
          </span>
        </div>

        {sidebar && (
          <div className="fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/60" onClick={() => setSidebar(false)} />
            <div className="relative z-10 flex h-full w-72 flex-col border-r border-white/10 bg-[#0a0a12] p-3">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-semibold">Chats</span>
                <button type="button" onClick={() => setSidebar(false)}><X className="h-4 w-4" /></button>
              </div>
              <button type="button" className="mb-2 flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm" onClick={() => { setMessages([]); setConversationId(null); setSidebar(false); }}>
                <Plus className="h-4 w-4" /> New chat
              </button>
              <div className="flex-1 overflow-y-auto">
                {conversations.map((c) => (
                  <div key={c.id} className={`mb-1 flex items-center gap-1 rounded-lg px-1 py-1 ${conversationId === c.id ? "bg-white/10" : "hover:bg-white/5"}`}>
                    <button type="button" className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm text-white/85" onClick={() => void openConversation(c.id)}>
                      {c.title}
                    </button>
                    <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/50 hover:bg-white/10 hover:text-white" aria-label="Rename chat" onClick={() => void renameConversation(c.id, c.title)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/50 hover:bg-red-500/20 hover:text-red-300" aria-label="Delete chat" onClick={() => void deleteConversation(c.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              {session && !isGuest && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  <button type="button" className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm text-white/80 hover:bg-white/10" onClick={() => setMemoryOpen((v) => !v)}>
                    <span className="flex items-center gap-2"><Brain className="h-4 w-4" /> Memory</span>
                    <span className="text-xs text-white/50">{memoryOn ? memories.length : "off"}</span>
                  </button>
                  {memoryOpen && (
                    <div className="mt-1 rounded-xl bg-white/5 p-2">
                      <label className="mb-2 flex cursor-pointer items-center justify-between gap-2 text-xs text-white/70">
                        <span>Let Zeros remember things about me</span>
                        <input type="checkbox" checked={memoryOn} onChange={(e) => toggleMemory(e.target.checked)} />
                      </label>
                      <div className="max-h-44 space-y-1 overflow-y-auto">
                        {memories.length === 0 && (
                          <p className="px-1 py-2 text-xs text-white/40">Nothing saved yet. Say “remember that …” or just chat.</p>
                        )}
                        {memories.map((m) => (
                          <div key={m.id} className="flex items-start gap-1 rounded-lg px-1 py-1 text-xs text-white/80 hover:bg-white/5">
                            <span className="min-w-0 flex-1 break-words">{m.fact}</span>
                            <button type="button" className="shrink-0 text-white/40 hover:text-red-300" aria-label="Forget this" onClick={() => void removeMemory(m.id)}>
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                      {memories.length > 0 && (
                        <button type="button" className="mt-2 text-xs text-red-300/80 hover:text-red-200" onClick={() => void wipeMemories()}>
                          Clear all memory
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
              {session && !isGuest && (
                <button type="button" className="mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-white/60 hover:bg-white/10" onClick={() => signOutFirebase()}>
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              )}
            </div>
          </div>
        )}

        {!messages.length && (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-1 pb-8 text-center">
            <ZerosOrb />
            <div>
              <h1 className="bg-gradient-to-r from-cyan-300 via-sky-300 to-fuchsia-400 bg-clip-text text-[2rem] font-bold tracking-tight text-transparent sm:text-4xl">
                Meet Zeros
              </h1>
              <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-white/50">
                Live web search, image generation, real 3D models, original songs and a code canvas — with memory that follows your account.
              </p>
            </div>
            <div className="flex w-full max-w-[22rem] flex-col gap-3 sm:max-w-md">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text}
                  type="button"
                  onClick={() => void send(s.text, s.mode)}
                  className="flex w-full items-center gap-3.5 rounded-full border border-white/[0.09] bg-black/45 px-5 py-[1.05rem] text-left text-[15px] font-medium text-white/90 shadow-[0_6px_28px_rgba(0,0,0,0.4)] backdrop-blur-md transition hover:bg-white/[0.08]"
                >
                  <s.Icon className="h-[18px] w-[18px] shrink-0 text-cyan-300/85" />
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {!!messages.length && (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-1 pb-4">
            {loadingChat && (
              <div aria-live="polite" className="mx-auto mb-3 w-fit rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground">Opening chat…</div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-full bg-cyan-400 px-4 py-2.5 text-[14px] font-medium text-black shadow-[0_4px_20px_rgba(34,211,238,0.35)]">
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[95%] space-y-2">
                    {m.content?.trim() ? (
                      <div className="prose prose-invert max-w-none text-sm prose-p:my-1.5">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: MarkdownPre, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{m.content}</ReactMarkdown>
                      </div>
                    ) : null}
                    {m.attachment?.kind === "video" && m.attachment.spec && (
                      <VideoPreview spec={m.attachment.spec} url={videoUrls[m.id]} format={videoFormats[m.id] ?? m.attachment.format ?? "webm"} audio={videoAudio[m.id] ?? m.attachment.audio} report={m.attachment.report} vtt={m.attachment.vtt} />
                    )}
                    {(() => {
                      const att = m.attachment;
                      if (att?.kind !== "song" || !att.spec) return null;
                      return (
                        <SongBlock
                          spec={att.spec} urls={songUrls[m.id]} info={att.info} report={att.report}
                          onRebuild={() => void rebuildSong(m.id, att.spec)} rebuilding={!!rebuilding[m.id]}
                          onStem={(st) => void renderStem(m.id, att.spec, st)} stemBusy={stemBusy[m.id] ?? null}
                        />
                      );
                    })()}
                    {m.attachment?.kind === "image" && !m.attachment.src && m.attachment.storagePath && (
                      <div className="mt-1 h-56 w-full max-w-sm animate-pulse rounded-xl bg-muted/50" aria-label="Restoring image" />
                    )}
                    {m.attachment?.kind === "apps" && (
                      <>
                        <AppChips apps={m.attachment.apps} />
                        {m.attachment.proposal && <ActionProposalCard proposal={m.attachment.proposal} />}
                      </>
                    )}
                    {m.attachment?.kind === "image" && m.attachment.src && (
                      <img src={m.attachment.src} alt="" className="mt-1 max-h-80 max-w-full rounded-xl" />
                    )}
                    {m.attachment?.kind === "forge" && m.attachment.code && (
                      <ForgeViewer code={m.attachment.code} name={m.attachment.prompt ?? "zeros-model"} score={m.attachment.score} />
                    )}
                    {m.attachment?.kind === "model" && m.attachment.spec && (
                      <div className="mt-1"><ModelViewer spec={m.attachment.spec as never} /></div>
                    )}
                    {m.attachment?.kind === "web" && m.attachment.project && (
                      <div className="mt-1"><WebPreview project={m.attachment.project} brief={m.attachment.brief ?? ""} report={m.attachment.report ?? null} /></div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="flex justify-start px-1">
                <ThinkingTrace active status={status || undefined} mode={thinkingMode} />
              </div>
            )}
            {error && <div className="rounded-2xl border border-red-400/40 bg-red-500/15 px-3 py-2 text-sm text-red-200">{error}</div>}
            <div ref={bottomRef} />
          </div>
        )}

        <SettingsButton isGuest={isGuest || !session} />
        <ZerosControls />
        <BillingGate isGuest={isGuest} />
        <ReturnHandlers />
        <Toaster />
        <DialogHost />
        <form
          className="fixed bottom-0 left-0 right-0 z-20 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <div className="mx-auto max-w-3xl rounded-[28px] border border-white/10 bg-black/70 px-3 pb-3 pt-2.5 shadow-[0_12px_48px_rgba(0,0,0,0.55)] backdrop-blur-xl">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={1}
              placeholder="Message Zeros…"
              className="mb-2 max-h-28 w-full resize-none bg-transparent px-3 py-2 text-[15px] text-white outline-none placeholder:text-white/40"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
            />
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMode(mode === m.id ? "chat" : m.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition ${
                      mode === m.id
                        ? "bg-white/15 text-white ring-1 ring-white/20"
                        : "border border-white/10 bg-white/[0.04] text-white/70"
                    }`}
                  >
                    <m.Icon className="h-3.5 w-3.5" />
                    {m.label}
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-cyan-400 shadow-[0_0_18px_rgba(56,189,248,0.35)] disabled:opacity-40"
                aria-label="Send"
              >
                <ArrowUp className="h-5 w-5" />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
