CREATE TABLE "channel_routings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"channel_key" text NOT NULL,
	"bot_token" text,
	"webhook_url" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_routings_agent_channel_key_uniq" UNIQUE("agent_id","channel","channel_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_routings" ADD CONSTRAINT "channel_routings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_routings" ADD CONSTRAINT "channel_routings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX "channel_routings_channel_key_idx" ON "channel_routings" USING btree ("channel","channel_key");
--> statement-breakpoint
CREATE INDEX "channel_routings_company_idx" ON "channel_routings" USING btree ("company_id");
