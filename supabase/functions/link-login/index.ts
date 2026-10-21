// Veltrix · link-login Edge Function
// Deploy:  supabase functions deploy link-login
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions automatically; the service-role key
//  never goes in the web app.)
//
// Input : { email, code }   (from the scanned QR)
// Output: { token_hash }    only when email + one-time code are correct. The app then calls
//                           supabase.auth.verifyOtp({ token_hash, type: "magiclink" }) to open the session.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const BAD = { error: "This QR code is invalid or has expired. Ask for a new one." };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const { email, code } = await req.json();
    if (typeof email !== "string" || typeof code !== "string" || code.length > 40 || email.length > 200) return json(BAD, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: uid, error } = await admin.rpc("consume_link_code", { p_email: email, p_code: code });
    if (error || !uid) return json(BAD, 401);

    const { data: u, error: e1 } = await admin.auth.admin.getUserById(uid as string);
    if (e1 || !u?.user?.email) return json(BAD, 401);
    const { data: link, error: e2 } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
    if (e2 || !link?.properties?.hashed_token) return json(BAD, 401);

    return json({ token_hash: link.properties.hashed_token });
  } catch {
    return json(BAD, 400);
  }
});
