import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/src/components/ui/dialog";
import { Button } from "@/src/components/ui/button";
import { api } from "@/src/utils/api";
import { showSuccessToast } from "@/src/features/notifications/showSuccessToast";
import { Loader2 } from "lucide-react";

type RunEvaluationDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  traceIds: string[];
};

export function RunEvaluationDialog({
  isOpen,
  onClose,
  projectId,
  traceIds,
}: RunEvaluationDialogProps) {
  const [errors, setErrors] = useState<string[]>([]);

  const runEval = api.evaluation.runOnTraces.useMutation({
    onSuccess: (data) => {
      showSuccessToast({
        title: "Evaluation complete",
        description: `Scored ${data.scored} trace${data.scored !== 1 ? "s" : ""}${data.skipped > 0 ? `, skipped ${data.skipped} (no input/output)` : ""}.`,
      });
      if (data.errors.length > 0) setErrors(data.errors);
      else onClose();
    },
  });

  const handleRun = () => {
    setErrors([]);
    runEval.mutate({ projectId, traceIds });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run LLM Evaluation</DialogTitle>
          <DialogDescription>
            Score {traceIds.length} trace{traceIds.length !== 1 ? "s" : ""}{" "}
            using the Downstream judge agent. Scores will be added for{" "}
            <strong>correctness</strong>, <strong>relevance</strong>, and{" "}
            <strong>tool_use</strong> (1–5 each).
          </DialogDescription>
        </DialogHeader>

        {runEval.error && (
          <p className="text-sm text-destructive">{runEval.error.message}</p>
        )}

        {errors.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded border p-2 text-xs text-destructive">
            {errors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={runEval.isPending}>
            Cancel
          </Button>
          <Button onClick={handleRun} disabled={runEval.isPending}>
            {runEval.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {runEval.isPending ? "Evaluating…" : "Run Evaluation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
