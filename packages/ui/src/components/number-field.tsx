"use client"

import * as React from "react"
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import { MinusIcon, PlusIcon } from "lucide-react"

import { cn } from "#lib/utils"

function NumberField({ className, ...props }: NumberFieldPrimitive.Root.Props) {
  return (
    <NumberFieldPrimitive.Root
      data-slot="number-field"
      className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function NumberFieldGroup({
  className,
  ...props
}: NumberFieldPrimitive.Group.Props) {
  return (
    <NumberFieldPrimitive.Group
      data-slot="number-field-group"
      className={cn(
        "flex h-8 w-full min-w-0 items-center overflow-hidden rounded-2xl border border-transparent bg-input/50 transition-[color,box-shadow] duration-200 outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

function NumberFieldInput({
  className,
  "aria-roledescription": roleDescription,
  ...props
}: NumberFieldPrimitive.Input.Props) {
  return (
    <NumberFieldPrimitive.Input
      data-slot="number-field-input"
      // Base UI's default is the English "Number field"; without a localized one supplied, the
      // screen reader's own role name for a text field is the better announcement.
      aria-roledescription={roleDescription}
      className={cn(
        "h-full w-full min-w-0 flex-1 bg-transparent px-2.5 py-1 text-base tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:text-sm",
        className
      )}
      {...props}
    />
  )
}

const numberFieldStepperClassName =
  "flex h-full shrink-0 items-center justify-center px-2 text-muted-foreground transition-colors outline-none select-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"

// Base UI names the steppers "Increase" / "Decrease" in English. This package has no i18n, so the
// caller must supply the localized name; requiring it makes an English one a compile error.
type NumberFieldStepperLabel = { "aria-label": string }

function NumberFieldDecrement({
  className,
  children,
  ...props
}: NumberFieldPrimitive.Decrement.Props & NumberFieldStepperLabel) {
  return (
    <NumberFieldPrimitive.Decrement
      data-slot="number-field-decrement"
      className={cn(numberFieldStepperClassName, className)}
      {...props}
    >
      {children ?? <MinusIcon />}
    </NumberFieldPrimitive.Decrement>
  )
}

function NumberFieldIncrement({
  className,
  children,
  ...props
}: NumberFieldPrimitive.Increment.Props & NumberFieldStepperLabel) {
  return (
    <NumberFieldPrimitive.Increment
      data-slot="number-field-increment"
      className={cn(numberFieldStepperClassName, className)}
      {...props}
    >
      {children ?? <PlusIcon />}
    </NumberFieldPrimitive.Increment>
  )
}

function NumberFieldScrubArea({
  className,
  ...props
}: NumberFieldPrimitive.ScrubArea.Props) {
  return (
    <NumberFieldPrimitive.ScrubArea
      data-slot="number-field-scrub-area"
      className={cn("cursor-ew-resize select-none", className)}
      {...props}
    />
  )
}

function NumberFieldScrubAreaCursor({
  className,
  ...props
}: NumberFieldPrimitive.ScrubAreaCursor.Props) {
  return (
    <NumberFieldPrimitive.ScrubAreaCursor
      data-slot="number-field-scrub-area-cursor"
      className={cn("drop-shadow-sm", className)}
      {...props}
    />
  )
}

export {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldScrubArea,
  NumberFieldScrubAreaCursor,
}
