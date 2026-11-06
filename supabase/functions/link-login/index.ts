// Veltrix · link-login Edge Function
// Deploy:  supabase functions deploy link-login
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions automatically; the service-role key
//  never goes in the web app.)
//
// Input : { email, code }   (from the scanned QR)
// Output: { token_hash }    only when email + one-time code are correct. The app then calls
//                           supabase.auth.verifyOtp({ token_hash, type: "magiclink" }) to open the session.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const BAD = { error: "This QR code is invalid or has expired. Ask for a new one." };
// Specific reasons raised by consume_link_code (see schema_phase30_link_login_fix.sql)
const REASONS: Record<string, string> = {
  no_account: "No account was found for this QR code. Ask for a new one.",
  no_code: "No active link code for that account. Ask for a new QR code.",
  expired: "This QR code has expired. Ask for a new one.",
  used: "This QR code was already used. Ask for a new one.",
  locked: "Too many wrong attempts. Ask for a new QR code.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { email, code } = await req.json();
    if (typeof email !== "string" || typeof code !== "string" || code.length > 40 || email.length > 200) return json(BAD, 400);
    const cleanEmail = email.trim().toLowerCase();
    const cleanCode = code.trim().toUpperCase();
    if (!cleanEmail || !/^[A-Z2-9]{12}$/.test(cleanCode)) return json(BAD, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: uid, error } = await admin.rpc("consume_link_code", { p_email: cleanEmail, p_code: cleanCode });
    if (error) {
      console.error("consume_link_code failed", error);
      const key = Object.keys(REASONS).find((k) => (error.message || "").includes(k));
      return json(key ? { error: REASONS[key], reason: key } : { error: "Link service error. Please try again.", reason: "rpc" }, key ? 401 : 500);
    }
    if (!uid) return json({ error: "This QR code is not valid. Ask for a new one.", reason: "wrong" }, 401);

    // From here on the code is already used up, so if anything fails we hand it back to let the scan be retried.
    const release = async () => { try { await admin.rpc("release_link_code", { p_user: uid }); } catch (_) { /* ignore */ } };
    const { data: u, error: e1 } = await admin.auth.admin.getUserById(uid as string);
    if (e1 || !u?.user?.email) { console.error("getUserById failed", e1); await release(); return json({ error: "Could not find the account. Try again.", reason: "user" }, 500); }
    const { data: link, error: e2 } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
    if (e2 || !link?.properties?.hashed_token) { console.error("generateLink failed", e2); await release(); return json({ error: "Could not start the sign-in. Try again.", reason: "link" }, 500); }

    return json({ token_hash: link.properties.hashed_token });
  } catch (e) {
    console.error("link-login crashed", e);
    return json(BAD, 400);
  }
});
