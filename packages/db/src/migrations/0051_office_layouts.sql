CREATE TABLE "office_layouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" text,
  "layout_data" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "office_layouts_company_user_idx" ON "office_layouts" ("company_id", "user_id") WHERE "user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "office_layouts_company_default_idx" ON "office_layouts" ("company_id") WHERE "user_id" IS NULL;
