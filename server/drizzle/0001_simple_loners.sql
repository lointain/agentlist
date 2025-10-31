CREATE TABLE "checkpoints" (
	"checkpoint_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_checkpoints_thread_run" ON "checkpoints" USING btree ("thread_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_events_run_id" ON "events" USING btree ("run_id");