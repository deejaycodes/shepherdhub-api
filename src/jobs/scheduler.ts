import cron from "node-cron";
import { supabase } from "../lib/supabase";
import { runTriggers } from "../routes/alerts";

export function startJobs() {
  // Every day at 8am — run pastoral care triggers for all churches
  cron.schedule("0 8 * * *", async () => {
    console.log("[cron] Running pastoral care triggers...");
    const { data: churches } = await supabase.from("churches").select("id");
    if (!churches) return;
    for (const c of churches) {
      const result = await runTriggers(c.id);
      console.log(`[cron] Church ${c.id}: ${result.generated} new alerts`);
    }
  });

  // Every Sunday at 10pm — attendance summary alert
  cron.schedule("0 22 * * 0", async () => {
    console.log("[cron] Generating attendance summaries...");
    const today = new Date().toISOString().split("T")[0];
    const { data: churches } = await supabase.from("churches").select("id, name");
    if (!churches) return;
    for (const church of churches) {
      const { count: present } = await supabase
        .from("attendance").select("id", { count: "exact", head: true })
        .eq("church_id", church.id).eq("service_date", today).eq("present", true);
      const { count: total } = await supabase
        .from("members").select("id", { count: "exact", head: true })
        .eq("church_id", church.id).eq("status", "active");
      console.log(`[cron] ${church.name}: ${present || 0}/${total || 0} attended today.`);
    }
  });

  console.log("[cron] Scheduled jobs started.");
}
