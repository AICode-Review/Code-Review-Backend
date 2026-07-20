import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await db.from("repos").select("id, name, index_status").order("name");
console.log(JSON.stringify(data, null, 2));
