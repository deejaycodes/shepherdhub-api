import { Router, Request, Response } from "express";
import { chat } from "../lib/openai";
import { supabase } from "../lib/supabase";

const router = Router();

// AI Compose — generate personalized messages
router.post("/compose", async (req: Request, res: Response) => {
  const { type, member, context, tone = "warm" } = req.body;

  const prompts: Record<string, string> = {
    "follow-up": `Write a short, ${tone} WhatsApp follow-up message for ${member?.first_name || "a member"} ${member?.last_name || ""} who hasn't attended church recently.${context ? ` Context: ${context}` : ""} Keep it under 3 sentences. Be genuine, not pushy.`,
    "announcement": `Write a short WhatsApp church announcement. ${tone} tone.${context ? ` Details: ${context}` : ""} Keep it concise. Add relevant emoji.`,
    "birthday": `Write a short, heartfelt birthday message for ${member?.first_name || "a member"}. ${tone} tone. Under 3 sentences.`,
    "absence": `Write a caring WhatsApp message to ${member?.first_name || "a member"} who has been absent for a few weeks. ${tone} tone. Don't guilt-trip. Under 3 sentences.`,
    "welcome": `Write a warm welcome WhatsApp message for ${member?.first_name || "a new visitor"} who visited church for the first time. Under 3 sentences.`,
    "ministry-dna": `${context}`,
  };

  const system = type === "ministry-dna"
    ? "You are a church ministry placement advisor. Based on the member's profile, recommend specific ministry departments and roles they would thrive in. Be practical and specific. Only output the recommendation, 3-4 sentences max."
    : "You are a helpful assistant for African church pastors. Write messages in simple, warm English. Only output the message text.";
  const message = await chat(system, prompts[type] || prompts["announcement"], 200);
  res.json({ message });
});

// AI Insights — churn risk + trends + suggestions
router.post("/insights", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];

  const [membersRes, attendanceRes, transactionsRes] = await Promise.all([
    supabase.from("members").select("id, first_name, last_name, status, department, created_at").eq("church_id", church.id),
    supabase.from("attendance").select("member_id, service_date, present").eq("church_id", church.id).gte("service_date", thirtyDaysAgo),
    supabase.from("transactions").select("type, amount, transaction_date").eq("church_id", church.id).gte("transaction_date", thirtyDaysAgo),
  ]);

  const members = membersRes.data || [];
  const attendance = attendanceRes.data || [];
  const transactions = transactionsRes.data || [];
  const serviceDates = [...new Set(attendance.map((a) => a.service_date))];

  // Churn risk calculation
  const churnRisk = members
    .filter((m) => m.status === "active")
    .map((m) => {
      const attended = attendance.filter((a) => a.member_id === m.id && a.present);
      const lastDate = attended.sort((a, b) => b.service_date.localeCompare(a.service_date))[0]?.service_date;
      const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : 999;
      const rate = attended.length / Math.max(1, serviceDates.length);

      let risk = 0;
      const reasons: string[] = [];
      if (daysSince > 21) { risk += 40; reasons.push(`absent ${daysSince} days`); }
      else if (daysSince > 14) { risk += 25; reasons.push(`absent ${daysSince} days`); }
      if (rate < 0.3) { risk += 30; reasons.push(`${Math.round(rate * 100)}% attendance`); }
      if (attended.length === 0) { risk = 90; reasons.splice(0, reasons.length, "no attendance in 30 days"); }

      return { member_id: m.id, name: `${m.first_name} ${m.last_name}`, risk: Math.min(risk, 100), reason: reasons.join(", ") };
    })
    .filter((m) => m.risk > 20)
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 15);

  // Trends
  const active = members.filter((m) => m.status === "active").length;
  const firstTimers = members.filter((m) => m.status === "first-timer").length;
  const avgAttendance = serviceDates.length > 0
    ? Math.round(attendance.filter((a) => a.present).length / serviceDates.length) : 0;
  const totalIncome = transactions.filter((t) => t.type !== "expense").reduce((s, t) => s + Number(t.amount), 0);

  const trends = [
    { label: "Total Members", value: String(members.length) },
    { label: "Active", value: String(active) },
    { label: "First Timers", value: String(firstTimers) },
    { label: "Avg Attendance", value: String(avgAttendance) },
    { label: "30-Day Income", value: `₦${totalIncome.toLocaleString()}` },
    { label: "At-Risk", value: String(churnRisk.length) },
  ];

  // AI suggestions
  const summary = `Church: ${members.length} members, ${active} active, ${firstTimers} first-timers, avg attendance ${avgAttendance}, ${churnRisk.length} at-risk, ₦${totalIncome.toLocaleString()} income. Top risks: ${churnRisk.slice(0, 5).map((c) => `${c.name} (${c.reason})`).join("; ")}`;
  const suggestionsText = await chat(
    "You are a church growth advisor. Give 3-4 short, actionable suggestions. One sentence each. Be practical.",
    summary
  );
  const suggestions = suggestionsText.split("\n").map((s) => s.replace(/^\d+[\.\)]\s*/, "").trim()).filter(Boolean);

  res.json({ churnRisk, trends, suggestions });
});

// AI Query — natural language questions about church data
router.post("/query", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });
  const { question } = req.body;

  const [membersRes, attendanceRes, transactionsRes] = await Promise.all([
    supabase.from("members").select("first_name, last_name, status, department, gender, member_since").eq("church_id", church.id),
    supabase.from("attendance").select("member_id, service_date, service_type, present").eq("church_id", church.id).order("service_date", { ascending: false }).limit(500),
    supabase.from("transactions").select("type, amount, transaction_date").eq("church_id", church.id).order("transaction_date", { ascending: false }).limit(200),
  ]);

  const members = membersRes.data || [];
  const attendance = attendanceRes.data || [];
  const transactions = transactionsRes.data || [];

  const dataContext = `Church data: ${members.length} members (${members.filter((m) => m.status === "active").length} active, ${members.filter((m) => m.status === "first-timer").length} first-timers). Gender: ${members.filter((m) => m.gender === "male").length}M/${members.filter((m) => m.gender === "female").length}F. Departments: ${[...new Set(members.map((m) => m.department).filter(Boolean))].join(", ") || "none"}. ${attendance.length} attendance records. ${transactions.length} transactions totaling ₦${transactions.reduce((s, t) => s + Number(t.amount), 0).toLocaleString()}.`;

  const answer = await chat(
    `You are a church data assistant. Answer using ONLY this data. Be specific with numbers. 2-3 sentences max.\n\n${dataContext}`,
    question,
    300
  );

  res.json({ answer });
});

// AI Sermon Planner
router.post("/sermon", async (req: Request, res: Response) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic is required" });

  const system = `You are a sermon preparation assistant for African church pastors. Given a topic or scripture, generate a structured sermon plan. Return ONLY valid JSON with these keys: title (sermon title), scripture (main scripture reference), outline (array of 4-5 main sections), points (array of 3-4 key takeaways), illustrations (array of 2-3 relatable stories or examples relevant to African church context), prayers (array of 3-4 prayer points), hymns (array of 3-4 suggested hymns or worship songs). Make it practical, biblical, and culturally relevant.`;

  const result = await chat(system, `Topic: ${topic}`, 1200);
  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    res.json(jsonMatch ? JSON.parse(jsonMatch[0]) : { title: topic, scripture: "", outline: [result], points: [], illustrations: [], prayers: [], hymns: [] });
  } catch {
    res.json({ title: topic, scripture: "", outline: [result], points: [], illustrations: [], prayers: [], hymns: [] });
  }
});

// AI Content Studio — generate social media + blog content
router.post("/content", async (req: Request, res: Response) => {
  const { topic, churchName } = req.body;
  if (!topic) return res.status(400).json({ error: "Topic is required" });

  const system = `You are a social media and content manager for "${churchName || "a church"}". Generate content for all platforms from one topic. Return ONLY valid JSON with these keys: twitter (max 270 chars, punchy, 1-2 hashtags), facebook (2-3 paragraphs, engaging, emojis), instagram (caption with hashtags and call to action), blog_title (compelling article title), blog_body (3-5 paragraphs, well-written article in markdown). Make content warm, faith-based, and engaging for an African church audience.`;

  const result = await chat(system, `Topic: ${topic}`, 1500);

  try {
    // Try to parse JSON from the response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    const content = jsonMatch ? JSON.parse(jsonMatch[0]) : { twitter: result, facebook: result, instagram: result, blog_title: topic, blog_body: result };
    res.json(content);
  } catch {
    res.json({ twitter: result, facebook: result, instagram: result, blog_title: topic, blog_body: result });
  }
});

export default router;
