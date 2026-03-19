import { Router } from "express";
import { supabase } from "../lib/supabase";
import { chat } from "../lib/openai";

const router = Router();

// Run all trigger checks for a church (called by cron or manually)
router.post("/run", async (req, res) => {
  const churchId = (req as any).churchId;
  const results = await runTriggers(churchId);
  res.json(results);
});

// Get alerts for a church
router.get("/", async (req, res) => {
  const churchId = (req as any).churchId;
  const { data } = await supabase
    .from("pastoral_alerts")
    .select("*")
    .eq("church_id", churchId)
    .order("created_at", { ascending: false })
    .limit(50);
  res.json(data || []);
});

// Dismiss an alert
router.patch("/:id/dismiss", async (req, res) => {
  const churchId = (req as any).churchId;
  await supabase.from("pastoral_alerts").update({ dismissed: true })
    .eq("id", req.params.id).eq("church_id", churchId);
  res.json({ ok: true });
});

export async function runTriggers(churchId: string) {
  const alerts: any[] = [];
  const today = new Date();
  const todayStr = today.toISOString().split("T")[0];

  // 1. Members who missed 3+ consecutive Sundays
  const threeWeeksAgo = new Date(today);
  threeWeeksAgo.setDate(today.getDate() - 21);

  const { data: activeMembers } = await supabase
    .from("members").select("id, first_name, last_name, phone")
    .eq("church_id", churchId).eq("status", "active");

  if (activeMembers) {
    for (const m of activeMembers) {
      const { data: recent } = await supabase
        .from("attendance").select("present, service_date")
        .eq("church_id", churchId).eq("member_id", m.id)
        .gte("service_date", threeWeeksAgo.toISOString().split("T")[0])
        .eq("service_type", "Sunday Service")
        .order("service_date", { ascending: false });

      const sundays = recent || [];
      const allAbsent = sundays.length >= 3 && sundays.slice(0, 3).every(r => !r.present);
      const noRecords = sundays.length === 0;

      if (allAbsent || noRecords) {
        // Check if we already alerted for this member recently
        const { data: existing } = await supabase
          .from("pastoral_alerts").select("id")
          .eq("church_id", churchId).eq("member_id", m.id).eq("type", "absent")
          .gte("created_at", threeWeeksAgo.toISOString()).maybeSingle();

        if (!existing) {
          const msg = await chat(
            "You are a pastoral care assistant. Write a short, caring WhatsApp message to check on a church member who hasn't attended in 3 weeks. 2-3 sentences. Warm, not guilt-tripping.",
            `Write a check-in message for ${m.first_name} ${m.last_name}.`
          );
          alerts.push({
            church_id: churchId, member_id: m.id, type: "absent",
            title: `${m.first_name} ${m.last_name} — missed 3+ Sundays`,
            message: msg, priority: "high",
          });
        }
      }
    }
  }

  // 2. First-timers who haven't returned after 2 weeks
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);

  const { data: firstTimers } = await supabase
    .from("members").select("id, first_name, last_name, phone, created_at")
    .eq("church_id", churchId).eq("status", "first-timer")
    .lte("created_at", twoWeeksAgo.toISOString());

  if (firstTimers) {
    for (const ft of firstTimers) {
      const { count } = await supabase
        .from("attendance").select("id", { count: "exact", head: true })
        .eq("church_id", churchId).eq("member_id", ft.id).eq("present", true);

      if ((count || 0) <= 1) {
        const { data: existing } = await supabase
          .from("pastoral_alerts").select("id")
          .eq("church_id", churchId).eq("member_id", ft.id).eq("type", "first-timer-no-return")
          .maybeSingle();

        if (!existing) {
          alerts.push({
            church_id: churchId, member_id: ft.id, type: "first-timer-no-return",
            title: `${ft.first_name} ${ft.last_name} — first-timer hasn't returned`,
            message: `${ft.first_name} visited ${new Date(ft.created_at).toLocaleDateString("en-NG", { day: "numeric", month: "short" })} but hasn't been back. Consider a personal follow-up call.`,
            priority: "medium",
          });
        }
      }
    }
  }

  // 3. Giving dropped significantly (50%+ drop month-over-month)
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split("T")[0];
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split("T")[0];

  if (activeMembers) {
    for (const m of activeMembers) {
      const { data: lastMonth } = await supabase
        .from("transactions").select("amount")
        .eq("church_id", churchId).eq("member_id", m.id).neq("type", "expense")
        .gte("transaction_date", lastMonthStart).lte("transaction_date", lastMonthEnd);

      const { data: thisMonthData } = await supabase
        .from("transactions").select("amount")
        .eq("church_id", churchId).eq("member_id", m.id).neq("type", "expense")
        .gte("transaction_date", thisMonth);

      const lastTotal = (lastMonth || []).reduce((s, r) => s + Number(r.amount), 0);
      const thisTotal = (thisMonthData || []).reduce((s, r) => s + Number(r.amount), 0);

      if (lastTotal > 0 && thisTotal < lastTotal * 0.5) {
        const { data: existing } = await supabase
          .from("pastoral_alerts").select("id")
          .eq("church_id", churchId).eq("member_id", m.id).eq("type", "giving-drop")
          .gte("created_at", thisMonth).maybeSingle();

        if (!existing) {
          alerts.push({
            church_id: churchId, member_id: m.id, type: "giving-drop",
            title: `${m.first_name} ${m.last_name} — giving dropped significantly`,
            message: `Giving went from ₦${lastTotal.toLocaleString()} last month to ₦${thisTotal.toLocaleString()} this month. This may indicate a pastoral care need.`,
            priority: "low",
          });
        }
      }
    }
  }

  // 4. Birthdays this week
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");

    const { data: bdays } = await supabase
      .from("members").select("id, first_name, last_name")
      .eq("church_id", churchId).like("date_of_birth", `%-${mm}-${dd}`);

    if (bdays) {
      for (const m of bdays) {
        const { data: existing } = await supabase
          .from("pastoral_alerts").select("id")
          .eq("church_id", churchId).eq("member_id", m.id).eq("type", "birthday")
          .gte("created_at", todayStr).maybeSingle();

        if (!existing) {
          const dayLabel = i === 0 ? "today" : i === 1 ? "tomorrow" : `on ${d.toLocaleDateString("en-NG", { weekday: "long" })}`;
          alerts.push({
            church_id: churchId, member_id: m.id, type: "birthday",
            title: `🎂 ${m.first_name} ${m.last_name}'s birthday is ${dayLabel}`,
            message: `Don't forget to wish ${m.first_name} a happy birthday!`,
            priority: "low",
          });
        }
      }
    }
  }

  // Insert all new alerts
  if (alerts.length > 0) {
    await supabase.from("pastoral_alerts").insert(alerts);
  }

  return { generated: alerts.length, alerts };
}

export default router;
