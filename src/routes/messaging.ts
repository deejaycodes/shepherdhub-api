import { Router } from "express";
import { supabase } from "../lib/supabase";
import { sendWhatsApp } from "../lib/twilio";

const router = Router();

const MESSAGES: Record<string, (name: string, church: string, serviceTimes: string) => string> = {
  welcome: (name, church, times) =>
    `Hi ${name}! 🙏 Welcome to ${church}. We're so glad you visited us! We'd love to see you again.${times ? ` Our service times: ${times}.` : ""} Feel free to reply here if you have any questions. God bless!`,
  "check-in": (name, church) =>
    `Hi ${name} 😊 Just checking in from ${church} — how was your experience on Sunday? We'd love to have you back this week!`,
  invite: (name, church, times) =>
    `Hi ${name}! 🏠 We have a special service coming up at ${church}${times ? ` (${times})` : ""} and we'd love for you to join us. See you there!`,
};

// GET /api/messaging/test — verify Twilio config
router.get("/test", async (_req, res) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  res.json({
    configured: !!(sid && process.env.TWILIO_AUTH_TOKEN && from),
    sid: sid ? `${sid.slice(0, 6)}...${sid.slice(-4)}` : "MISSING",
    from: from || "MISSING",
  });
});

// POST /api/messaging/bulk — send all pending follow-up messages
router.post("/bulk", async (req, res) => {
  const churchId = (req as any).church.id;

  // Get church info for message personalization
  const { data: church } = await supabase.from("churches").select("name, service_times").eq("id", churchId).single();
  if (!church) return res.status(404).json({ error: "Church not found" });

  // Get all incomplete follow-ups with member info
  const { data: followUps } = await supabase
    .from("follow_ups")
    .select("id, step, member_id, members(first_name, phone)")
    .eq("church_id", churchId)
    .eq("completed", false)
    .in("step", ["welcome", "check-in", "invite"]);

  if (!followUps?.length) return res.json({ sent: 0, skipped: 0, results: [] });

  // Get attendance counts per member for gate checks
  const memberIds = [...new Set(followUps.map((f: any) => f.member_id))];
  const { data: attendance } = await supabase
    .from("attendance")
    .select("member_id")
    .eq("church_id", churchId)
    .eq("present", true)
    .in("member_id", memberIds);

  const attendanceCounts: Record<string, number> = {};
  for (const a of attendance || []) {
    attendanceCounts[a.member_id] = (attendanceCounts[a.member_id] || 0) + 1;
  }

  // Check which steps are completed per member
  const { data: allFollowUps } = await supabase
    .from("follow_ups")
    .select("member_id, step, completed")
    .eq("church_id", churchId)
    .in("member_id", memberIds);

  const completedSteps: Record<string, Set<string>> = {};
  for (const f of allFollowUps || []) {
    if (f.completed) {
      if (!completedSteps[f.member_id]) completedSteps[f.member_id] = new Set();
      completedSteps[f.member_id].add(f.step);
    }
  }

  const results: { member: string; step: string; status: string; error?: string }[] = [];
  let sent = 0, skipped = 0;

  for (const fu of followUps as any[]) {
    const member = fu.members;
    const name = member?.first_name || "Friend";
    const phone = member?.phone;
    const done = completedSteps[fu.member_id] || new Set();
    const count = attendanceCounts[fu.member_id] || 0;

    // Gate checks
    let blocked = "";
    if (fu.step === "check-in" && !done.has("welcome")) blocked = "Welcome not done";
    else if (fu.step === "check-in" && !phone) blocked = "No phone";
    else if (fu.step === "invite" && !done.has("check-in")) blocked = "Check-in not done";
    else if (fu.step === "invite" && count < 1) blocked = "No attendance yet";
    else if (!phone) blocked = "No phone";

    if (blocked) {
      results.push({ member: name, step: fu.step, status: "skipped", error: blocked });
      skipped++;
      continue;
    }

    const msgFn = MESSAGES[fu.step];
    if (!msgFn) { skipped++; continue; }

    try {
      await sendWhatsApp(phone, msgFn(name, church.name, church.service_times || ""));
      await supabase.from("follow_ups").update({ completed: true, completed_at: new Date().toISOString() }).eq("id", fu.id);
      results.push({ member: name, step: fu.step, status: "sent" });
      sent++;
    } catch (e: any) {
      results.push({ member: name, step: fu.step, status: "failed", error: `${e.code || e.status || ""} ${e.message}` });      skipped++;
    }
  }

  res.json({ sent, skipped, results });
});

export default router;
