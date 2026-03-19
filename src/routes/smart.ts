import { Router, Request, Response } from "express";
import { chat } from "../lib/openai";
import { supabase } from "../lib/supabase";

const router = Router();

// Engagement scores for all members
router.post("/engagement", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];

  const [membersRes, attendanceRes, transactionsRes, followUpsRes] = await Promise.all([
    supabase.from("members").select("*").eq("church_id", church.id),
    supabase.from("attendance").select("member_id, service_date, present").eq("church_id", church.id).gte("service_date", ninetyDaysAgo),
    supabase.from("transactions").select("member_id, amount, transaction_date").eq("church_id", church.id).gte("transaction_date", ninetyDaysAgo).neq("type", "expense"),
    supabase.from("follow_ups").select("member_id, completed").eq("church_id", church.id),
  ]);

  const members = membersRes.data || [];
  const attendance = attendanceRes.data || [];
  const transactions = transactionsRes.data || [];
  const followUps = followUpsRes.data || [];
  const serviceDates = [...new Set(attendance.map((a) => a.service_date))];
  const recentDates = serviceDates.filter((d) => d >= thirtyDaysAgo);

  const scores = members.map((m) => {
    const memberAttendance = attendance.filter((a) => a.member_id === m.id && a.present);
    const recentAttendance = memberAttendance.filter((a) => a.service_date >= thirtyDaysAgo);
    const memberGiving = transactions.filter((t) => t.member_id === m.id);
    const memberFollowUps = followUps.filter((f) => f.member_id === m.id);

    // Attendance score (0-40)
    const attendanceRate = recentDates.length > 0 ? recentAttendance.length / recentDates.length : 0;
    const attendanceScore = Math.round(attendanceRate * 40);

    // Consistency score (0-20) — how regular over 90 days
    const totalRate = serviceDates.length > 0 ? memberAttendance.length / serviceDates.length : 0;
    const consistencyScore = Math.round(totalRate * 20);

    // Giving score (0-20)
    const givingScore = Math.min(20, memberGiving.length * 5);

    // Engagement trend (0-20) — improving or declining
    const olderAttendance = memberAttendance.filter((a) => a.service_date < thirtyDaysAgo);
    const olderDates = serviceDates.filter((d) => d < thirtyDaysAgo);
    const olderRate = olderDates.length > 0 ? olderAttendance.length / olderDates.length : 0;
    const trendDiff = attendanceRate - olderRate;
    const trendScore = Math.round(Math.max(0, Math.min(20, 10 + trendDiff * 20)));

    const total = attendanceScore + consistencyScore + givingScore + trendScore;

    const label = total >= 75 ? "Highly Engaged" : total >= 50 ? "Engaged" : total >= 30 ? "At Risk" : "Disengaged";

    return {
      member_id: m.id,
      name: `${m.first_name} ${m.last_name}`,
      department: m.department,
      status: m.status,
      score: total,
      label,
      breakdown: { attendance: attendanceScore, consistency: consistencyScore, giving: givingScore, trend: trendScore },
      trend: trendDiff > 0.1 ? "up" : trendDiff < -0.1 ? "down" : "stable",
    };
  });

  scores.sort((a, b) => b.score - a.score);
  res.json({ scores });
});

// AI Member Profile — deep analysis of one member
router.post("/member-profile", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });
  const { member_id } = req.body;

  const [memberRes, attendanceRes, transactionsRes, followUpsRes] = await Promise.all([
    supabase.from("members").select("*").eq("id", member_id).single(),
    supabase.from("attendance").select("service_date, present, service_type").eq("member_id", member_id).order("service_date", { ascending: false }).limit(50),
    supabase.from("transactions").select("type, amount, transaction_date").eq("member_id", member_id).order("transaction_date", { ascending: false }).limit(20),
    supabase.from("follow_ups").select("step, completed, due_date").eq("member_id", member_id),
  ]);

  const member = memberRes.data;
  if (!member) return res.status(404).json({ error: "Member not found" });

  const attendance = attendanceRes.data || [];
  const transactions = transactionsRes.data || [];
  const followUps = followUpsRes.data || [];

  const present = attendance.filter((a) => a.present).length;
  const totalGiving = transactions.reduce((s, t) => s + Number(t.amount), 0);
  const lastAttended = attendance.find((a) => a.present)?.service_date || "never";

  const dataForAI = `Member: ${member.first_name} ${member.last_name}, status: ${member.status}, department: ${member.department || "none"}, joined: ${member.member_since || member.created_at}. Attendance: ${present}/${attendance.length} services attended, last attended: ${lastAttended}. Giving: ₦${totalGiving.toLocaleString()} total from ${transactions.length} transactions. Follow-ups: ${followUps.filter((f) => f.completed).length}/${followUps.length} completed.`;

  const summary = await chat(
    "You are a pastoral care assistant. Write a brief 3-4 sentence profile summary for a church leader. Highlight strengths, concerns, and one specific action the pastor should take. Be warm but direct.",
    dataForAI,
    200
  );

  res.json({
    member,
    stats: {
      attendanceRate: attendance.length > 0 ? Math.round((present / attendance.length) * 100) : 0,
      totalGiving,
      lastAttended,
      servicesAttended: present,
      followUpsCompleted: followUps.filter((f) => f.completed).length,
    },
    attendance: attendance.slice(0, 12),
    transactions: transactions.slice(0, 10),
    aiSummary: summary,
  });
});

// Predictive attendance
router.post("/predict-attendance", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });

  const { data: attendance } = await supabase
    .from("attendance").select("service_date, present")
    .eq("church_id", church.id).eq("present", true)
    .order("service_date", { ascending: false }).limit(200);

  const { count: totalMembers } = await supabase
    .from("members").select("id", { count: "exact", head: true })
    .eq("church_id", church.id).eq("status", "active");

  if (!attendance || attendance.length === 0) {
    return res.json({ predicted: 0, confidence: "low", trend: "stable", history: [] });
  }

  // Group by service date
  const byDate: Record<string, number> = {};
  for (const a of attendance) {
    byDate[a.service_date] = (byDate[a.service_date] || 0) + 1;
  }

  const history = Object.entries(byDate)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const recent = history.slice(-4);
  const avg = recent.reduce((s, h) => s + h.count, 0) / Math.max(1, recent.length);
  const older = history.slice(-8, -4);
  const olderAvg = older.length > 0 ? older.reduce((s, h) => s + h.count, 0) / older.length : avg;

  const trend = avg > olderAvg * 1.1 ? "growing" : avg < olderAvg * 0.9 ? "declining" : "stable";
  const predicted = Math.round(avg);
  const confidence = history.length >= 4 ? "high" : history.length >= 2 ? "medium" : "low";

  res.json({ predicted, total: totalMembers || 0, confidence, trend, history: history.slice(-12) });
});

// Weekly report
router.post("/weekly-report", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];

  const [attendanceRes, transactionsRes, newMembersRes, followUpsRes] = await Promise.all([
    supabase.from("attendance").select("service_date, present").eq("church_id", church.id).gte("service_date", weekAgo),
    supabase.from("transactions").select("type, amount").eq("church_id", church.id).gte("transaction_date", weekAgo),
    supabase.from("members").select("first_name, last_name, status").eq("church_id", church.id).gte("created_at", weekAgo),
    supabase.from("follow_ups").select("step, completed").eq("church_id", church.id).gte("due_date", weekAgo),
  ]);

  const attendance = attendanceRes.data || [];
  const transactions = transactionsRes.data || [];
  const newMembers = newMembersRes.data || [];
  const followUps = followUpsRes.data || [];

  const present = attendance.filter((a) => a.present).length;
  const income = transactions.filter((t) => t.type !== "expense").reduce((s, t) => s + Number(t.amount), 0);
  const expenses = transactions.filter((t) => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  const completedFollowUps = followUps.filter((f) => f.completed).length;

  const dataForAI = `Weekly report for ${church.name}: Attendance: ${present} across ${[...new Set(attendance.map((a) => a.service_date))].length} services. Income: ₦${income.toLocaleString()}, Expenses: ₦${expenses.toLocaleString()}. New members: ${newMembers.length} (${newMembers.map((m) => `${m.first_name} ${m.last_name}`).join(", ") || "none"}). Follow-ups: ${completedFollowUps}/${followUps.length} completed this week.`;

  const report = await chat(
    "You are a church admin assistant. Write a concise weekly report for the senior pastor. Use bullet points. Include highlights, concerns, and 2 action items for next week. Keep it under 200 words. Be encouraging but honest.",
    dataForAI,
    400
  );

  res.json({
    report,
    stats: { attendance: present, income, expenses, newMembers: newMembers.length, followUpsCompleted: completedFollowUps, followUpsTotal: followUps.length },
  });
});

// Smart roster generator
router.post("/generate-roster", async (req: Request, res: Response) => {
  const church = (req as any).church;
  if (!church) return res.status(400).json({ error: "No church" });
  const { department_id, service_date, count = 5 } = req.body;

  // Get department members
  const { data: dept } = await supabase.from("departments").select("name").eq("id", department_id).single();
  if (!dept) return res.status(404).json({ error: "Department not found" });

  // Get members in this department
  const { data: members } = await supabase
    .from("members").select("id, first_name, last_name, department")
    .eq("church_id", church.id).eq("status", "active");

  const deptMembers = (members || []).filter((m) => m.department === dept.name);
  if (deptMembers.length === 0) return res.json({ assignments: [], reason: "No members in this department" });

  // Get recent assignments to ensure fairness
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000).toISOString().split("T")[0];
  const { data: recentAssignments } = await supabase
    .from("roster_assignments").select("member_id, service_date")
    .eq("department_id", department_id).gte("service_date", fourWeeksAgo);

  // Count recent assignments per member
  const assignmentCounts: Record<string, number> = {};
  for (const m of deptMembers) assignmentCounts[m.id] = 0;
  for (const a of recentAssignments || []) {
    if (assignmentCounts[a.member_id] !== undefined) assignmentCounts[a.member_id]++;
  }

  // Sort by least recently assigned (fairness)
  const sorted = [...deptMembers].sort((a, b) => (assignmentCounts[a.id] || 0) - (assignmentCounts[b.id] || 0));
  const selected = sorted.slice(0, Math.min(count, sorted.length));

  // Save assignments
  const rows = selected.map((m) => ({
    church_id: church.id, department_id, member_id: m.id, service_date,
  }));

  const { data: saved } = await supabase.from("roster_assignments").upsert(rows, { onConflict: "department_id,member_id,service_date" }).select();

  res.json({
    assignments: selected.map((m) => ({
      member_id: m.id,
      name: `${m.first_name} ${m.last_name}`,
      recentCount: assignmentCounts[m.id] || 0,
    })),
    department: dept.name,
    date: service_date,
    saved: saved?.length || 0,
  });
});

export default router;
