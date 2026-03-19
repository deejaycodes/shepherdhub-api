import { Router } from "express";
import { supabase } from "../lib/supabase";

const router = Router();

// Public — get church blog posts
router.get("/:churchId", async (req, res) => {
  const { data: church } = await supabase
    .from("churches").select("name, city").eq("id", req.params.churchId).maybeSingle();
  if (!church) return res.status(404).json({ error: "Church not found" });

  const { data: posts } = await supabase
    .from("blog_posts").select("id, title, body, image_url, created_at")
    .eq("church_id", req.params.churchId).eq("published", true)
    .order("created_at", { ascending: false }).limit(20);

  res.json({ church, posts: posts || [] });
});

// Public — get single post
router.get("/:churchId/:postId", async (req, res) => {
  const { data: post } = await supabase
    .from("blog_posts").select("*")
    .eq("id", req.params.postId).eq("church_id", req.params.churchId).eq("published", true)
    .maybeSingle();
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { data: church } = await supabase
    .from("churches").select("name, city").eq("id", req.params.churchId).maybeSingle();

  res.json({ church, post });
});

export default router;
