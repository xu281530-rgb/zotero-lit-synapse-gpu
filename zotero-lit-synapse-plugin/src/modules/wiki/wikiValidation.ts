interface ValidationIssue {
  path: string;
  code: string;
  message: string;
  section?: string;
  details?: unknown;
}

/** Aggregate independent checks; callers explicitly gate checks that require valid citations. */
export class WikiValidation {
  private issues: ValidationIssue[] = [];
  private errors: Error[] = [];
  private metadata: Record<string, unknown>;
  constructor(metadata: Record<string, unknown>) {
    this.metadata = metadata;
  }

  check(
    path: string,
    code: string,
    check: () => void,
    section?: string,
  ): boolean {
    try {
      check();
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.errors.push(error);
      this.issues.push({
        path,
        code,
        message: error.message,
        section,
        details: (error as any).details,
      });
      return false;
    }
  }

  finish(): void {
    if (!this.issues.length) return;
    const error =
      this.errors.length === 1
        ? this.errors[0]
        : Object.assign(
            new Error(
              this.issues
                .map((i) => `${i.section ?? i.path}: ${i.message}`)
                .join("\n\n"),
            ),
            { name: "WikiValidationError", code: "VALIDATION_FAILED" },
          );
    const audit = this.errors.find(
      (e) => e.name === "WikiSynthesisAuditRequired",
    ) as any;
    Object.assign(error, {
      details: {
        ...(error as any).details,
        ...this.metadata,
        ...(audit
          ? {
              activeIssues: audit.details.activeIssues,
              staleAuditIds: audit.details.staleAuditIds,
            }
          : {}),
        validationIssues: this.issues,
      },
    });
    throw error;
  }
}
