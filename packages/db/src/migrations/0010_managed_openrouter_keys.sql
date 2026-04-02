CREATE TABLE "managed_openrouter_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"secret_id" uuid NOT NULL,
	"provider_key_id" text NOT NULL,
	"spending_cap_cents" integer DEFAULT 500 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_known_usage_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_openrouter_keys" ADD CONSTRAINT "managed_openrouter_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_openrouter_keys" ADD CONSTRAINT "managed_openrouter_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_openrouter_keys" ADD CONSTRAINT "managed_openrouter_keys_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_or_keys_company_idx" ON "managed_openrouter_keys" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "managed_or_keys_agent_idx" ON "managed_openrouter_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "managed_or_keys_agent_uq" ON "managed_openrouter_keys" USING btree ("agent_id");
