/**
 * The fake JSX runtime deliberately never executes child React components.
 * For this component-level smoke, represent the shared CDS Button as its
 * documented native button root so aria-current/className on SkillNodesView's
 * actual JSX props are observable. Production Button forwards both to BaseButton.
 */
export const Button = "button";
