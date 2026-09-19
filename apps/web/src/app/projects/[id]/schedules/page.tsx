import Link from "next/link";
import { agentPath } from "@evelab/eve-project";
import { IconClock } from "@/components/icons";
import { ConfirmSubmit } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { ScheduleRunButton } from "@/components/schedule-run-button";
import { Reveal, Stagger, StaggerItem } from "@/components/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createScheduleAction, deleteScheduleAction } from "@/lib/actions";
import { CRON_PRESETS, describeCron } from "@/lib/cron";
import { getProject } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function SchedulesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  const directory = agentPath(project.root, "schedules/");

  return (
    <div className="page">
      <Reveal>
        <header className="page-header">
          <div className="page-heading">
            <h1 className="page-title">Schedules</h1>
            <p className="page-description">
              Work the agent starts on its own. Each file under <code className="mono">{directory}</code> is a
              cron and a prompt; on Vercel every schedule becomes a Vercel Cron Job that starts a fresh session.
            </p>
          </div>
        </header>
      </Reveal>

      {project.schedules.length === 0 ? (
        <Reveal delay={0.06}>
          <EmptyState icon={IconClock} title="No schedules.">
            Add one for a daily digest, a weekly cleanup, or anything the agent should do without being asked.
          </EmptyState>
        </Reveal>
      ) : (
        <Stagger className="section">
          {project.schedules.map((schedule) => {
            const path = `${directory}${schedule.file}`;
            return (
              <StaggerItem key={schedule.id}>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle className="font-mono">{schedule.id}</CardTitle>
                    <CardDescription>{describeCron(schedule.cron) || "No cron"}</CardDescription>
                    <CardAction className="flex flex-wrap items-center gap-x-4 gap-y-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start max-sm:gap-x-2">
                      {/* On a phone the cron gets its own line, so the three actions stay together on the next. */}
                      <span className="flex max-sm:basis-full">
                        <Badge variant="secondary" className="font-mono">
                          {schedule.cron || "missing cron"}
                        </Badge>
                      </span>
                      <ScheduleRunButton projectId={id} scheduleId={schedule.id} />
                      <Button asChild variant="ghost">
                        <Link href={`/projects/${id}/files?path=${encodeURIComponent(path)}`}>Edit</Link>
                      </Button>
                      <form action={deleteScheduleAction}>
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="scheduleId" value={schedule.id} />
                        <ConfirmSubmit title={`Remove ${schedule.id}?`} description={`Deletes ${path}.`} confirmLabel="Remove">
                          Remove
                        </ConfirmSubmit>
                      </form>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <p className="list-item-detail line-clamp-2">
                      {schedule.handler
                        ? "Runs a handler written in code."
                        : schedule.promptExpression
                          ? "Runs a prompt composed in code."
                          : schedule.prompt || "No prompt"}
                    </p>
                  </CardContent>
                </Card>
              </StaggerItem>
            );
          })}
        </Stagger>
      )}

      <Reveal delay={0.1}>
        <Card>
          <form action={createScheduleAction} className="contents">
            <CardHeader>
              <CardTitle>Add a schedule</CardTitle>
              <CardDescription>Writes {directory}&lt;name&gt;.md with the cron in frontmatter.</CardDescription>
            </CardHeader>
            <CardContent>
              <input type="hidden" name="projectId" value={id} />
              <div className="grid-2">
                <Field>
                  <FieldLabel htmlFor="scheduleId">Name</FieldLabel>
                  <Input
                    className="font-mono"
                    id="scheduleId"
                    name="scheduleId"
                    placeholder="daily-digest"
                    pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="cron">Cron</FieldLabel>
                  <Input className="font-mono" id="cron" name="cron" list="cron-presets" placeholder="0 9 * * 1-5" required />
                  <datalist id="cron-presets">
                    {CRON_PRESETS.map((preset) => (
                      <option key={preset.cron} value={preset.cron}>
                        {preset.label}
                      </option>
                    ))}
                  </datalist>
                  <FieldDescription>Five fields, in UTC.</FieldDescription>
                </Field>
              </div>
              <Field className="mt-4">
                <FieldLabel htmlFor="prompt">Prompt</FieldLabel>
                <Textarea id="prompt" name="prompt" rows={4} placeholder="Summarize yesterday's new support tickets." required />
                <FieldDescription>Sent to the agent as the first message of each scheduled session.</FieldDescription>
              </Field>
            </CardContent>
            <CardFooter className="justify-end">
              <Button type="submit">Add schedule</Button>
            </CardFooter>
          </form>
        </Card>
      </Reveal>
    </div>
  );
}
