/** Auto-appended trailing option that opens an inline text input.
 *  The model is asked not to add its own entry so every question gets one
 *  consistent escape hatch into free-form text. */
export const OTHER_OPTION = {
  label: 'Other',
  description: 'Type a custom answer.',
  freeform: true as const,
}
