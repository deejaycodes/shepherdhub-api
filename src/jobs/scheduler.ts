import cron from "node-cron";
import { supabase } from "../lib/supabase";
import { chat } from "../lib/openai";

export function startJobs() {
  // Every day at 8am — check for follow-up reminders due today
  cron.schedule("0 8 * * *", async () => {
    console.log("[cron] Checking follow-up reminders...");
    const today = new Date().toISOString().split("T")[0];

    const { data: dueFollowUps } = await supabase
      .from("follow_ups")
      .select("*, members(first_name, last_name, phone), churches(name)")
      .eq("due_date", today)
      .eq("completed", false);

    if (!dueFollowUps?.length) return console.log("[cron] No follow-ups due today.");

    for (const fu of dueFollowUps) {
      const member = (fu as any).members;
      const church = (fu as any).churches;
      console.log(`[cron] Follow-up due: ${fu.step} for ${member?.first_name} ${member?.last_name} (${church?.name})`);
      // In production: send WhatsApp reminder to the pastor/admin
      // For now, just log it
    }
    console.log(`[cron] ${dueFollowUps.length} follow-ups due today.`);
  });

  // Every Monday at 7am — send weekly roster reminders
  cron.schedule("0 7 * * 1", async () => {
    console.log("[cron] Sending roster reminders...");
    const nextSunday = new Date();
    nextSunday.setDate(nextSunday.getDate() + (7 - nextSunday.getDay()));
    const sundayStr = nextSunday.toISOString().split("T")[0];

    const { data: assignments } = await supabase
      .from("roster_assignments")
      .select("*, members(first_name, last_name, phone), departments(name)")
      .eq("service_date", sundayStr);

    if (!assignments?.length) return console.log("[cron] No roster assignments for next Sunday.");

    for (const a of assignments) {
      const member = (a as any).members;
      const dept = (a as any).departments;
      console.log(`[cron] Roster reminder: ${member?.first_name} ${member?.last_name} → ${dept?.name} on ${sundayStr}`);
      // In production: send WhatsApp message to member
    }
    console.log(`[cron] ${assignments.length} roster reminders for ${sundayStr}.`);
  });

  // Every day at 9am — birthday messages
  cron.schedule("0 9 * * *", async () => {
    console.log("[cron] Checking birthdays...");
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");

    // Find members whose date_of_birth month/day matches today
    const { data: members } = await supabase
      .from("members")
      .select("id, first_name, last_name, phone, church_id")
      .like("date_of_birth", `%-${month}-${day}`);

    if (!members?.length) return console.log("[cron] No birthdays today.");

    for (const m of members) {
      const message = await chat(
        "You are a church assistant. Write a short, heartfelt birthday message. 2 sentences max. Warm tone.",
        `Write a birthday message for ${m.first_name} ${m.last_name}.`
      );
      console.log(`[cron] Birthday: ${m.first_name} ${m.last_name} — "${message}"`);
      // In production: send via WhatsApp
    }
    console.log(`[cron] ${members.length} birthdays today.`);
  });

  // Every Sunday at 10pm — attendance summary
  cron.schedule("0 22 * * 0", async () => {
    console.log("[cron] Generating attendance summary...");
    const today = new Date().toISOString().split("T")[0];

    const { data: churches } = await supabase.from("churches").select("id, name, owner_id");
    if (!churches) return;

    for (const church of churches) {
      const { count: present } = await supabase
        .from("attendance").select("id", { count: "exact", head: true })
        .eq("church_id", church.id).eq("service_date", today).eq("present", true);

      const { count: total } = await supabase
        .from("members").select("id", { count: "exact", head: true })
        .eq("church_id", church.id).eq("status", "active");

      console.log(`[cron] ${church.name}: ${present || 0}/${total || 0} attended today.`);
      // In production: send summary to pastor via WhatsApp
    }
  });

  console.log("[cron] Scheduled jobs started.");
}
