/**
 * src/core/utils/cva.ts
 *
 * Typed re-export of class-variance-authority (shadcn/ui philosophy).
 * Consumers build variant-capable recipes:
 *
 *   const switchRecipe = cva('gm-ui-switch', {
 *     variants: { size: { sm: 'gm-ui-switch-sm', md: 'gm-ui-switch-md' } },
 *     defaultVariants: { size: 'md' }
 *   });
 *   type SwitchVariants = VariantProps<typeof switchRecipe>;
 */

export { cva } from 'class-variance-authority';
export type { VariantProps } from 'class-variance-authority';