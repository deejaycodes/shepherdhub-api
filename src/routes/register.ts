import { Router } from "express";
import { supabase } from "../lib/supabase";

const router = Router();

router.post("/:churchId", async (req, res) => {
  const { churchId } = req.params;
  const { first_name, last_name, phone, email, gender, date_of_birth } = req.body;

  if (!first_name || !last_name || !phone) {
    return res.status(400).json({ error: "First name, last name, and phone are required" });
  }

  // Verify church
  const { data: church } = await supabase
    .from("churches").select("id").eq("id", churchId).maybeSingle();
  if (!church) return res.status(404).json({ error: "Church not found" });

  // Check duplicate phone
  const { data: existing } = await supabase
    .from("members").select("id").eq("church_id", churchId).eq("phone", phone.trim()).maybeSingle();
  if (existing) return res.status(409).json({ error: "This phone number is already registered" });

  const { error } = await supabase.from("members").insert({
    church_id: churchId,
    first_name: first_name.trim(),
    last_name: last_name.trim(),
    phone: phone.trim(),
    email: email?.trim() || null,
    gender: gender || null,
    date_of_birth: date_of_birth || null,
    status: "first-timer",
  });

  if (error) return res.status(500).json({ error: "Registration failed" });
  res.json({ ok: true });
});

export default router;
