import { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase";

// Verify the user's JWT and attach user + church to request
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid token" });

  // Get user's church
  const { data: church } = await supabase
    .from("churches").select("*").eq("owner_id", user.id).single();

  (req as any).user = user;
  (req as any).church = church;
  next();
}
