import { Router } from "express";
import { supabase } from "../lib/supabase";

const router = Router();

// Public — get church name (no auth)
router.get("/:churchId/info", async (req, res) => {
  const { data } = await supabase
    .from("churches").select("name, city").eq("id", req.params.churchId).maybeSingle();
  if (!data) return res.status(404).json({ error: "Church not found" });
  res.json(data);
});

// Public — check in by phone number
router.post("/:churchId", async (req, res) => {
  const { churchId } = req.params;
  const { phone, first_name, last_name } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number is required" });

  // Verify church exists
  const { data: church } = await supabase
    .from("churches").select("id").eq("id", churchId).maybeSingle();
  if (!church) return res.status(404).json({ error: "Church not found" });

  // Find member by phone
  let { data: member } = await supabase
    .from("members").select("id, first_name, last_name")
    .eq("church_id", churchId).eq("phone", phone.trim()).maybeSingle();

  // If not found and first-timer info provided, create them
  if (!member && first_name && last_name) {
    const { data: newMember, error } = await supabase
      .from("members").insert({
        church_id: churchId, first_name: first_name.trim(), last_name: last_name.trim(),
        phone: phone.trim(), status: "first-timer",
      }).select("id, first_name, last_name").single();
    if (error) return res.status(500).json({ error: "Could not register" });
    member = newMember;
  }

  if (!member) {
    return res.status(404).json({ error: "Phone number not found. Check the box if you're a first-time visitor." });
  }

  // Record attendance for today
  const today = new Date().toISOString().split("T")[0];
  const serviceType = new Date().getDay() === 0 ? "Sunday Service" : "Midweek Service";

  // Check if already checked in
  const { data: existing } = await supabase
    .from("attendance").select("id")
    .eq("church_id", churchId).eq("member_id", member.id)
    .eq("service_date", today).eq("service_type", serviceType).maybeSingle();

  if (!existing) {
    await supabase.from("attendance").insert({
      church_id: churchId, member_id: member.id,
      service_date: today, service_type: serviceType, present: true,
    });
  }

  res.json({ name: member.first_name, already: !!existing });
});

export default router;
