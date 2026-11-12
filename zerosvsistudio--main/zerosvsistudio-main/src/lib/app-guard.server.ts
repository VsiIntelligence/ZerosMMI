/** The shared front door for app routes: the caller must be signed in and hold a plan (or a promo). */
import { requireAccess, type Access } from "./access.server";

export async function requirePaidUser(request: Request): Promise<{ ok: true; uid: string; access: Access } | { ok: false; response: Response }> {
  const result = await requireAccess(request);
  if (!result.ok) return result;
  return { ok: true, uid: result.access.uid, access: result.access };
}
