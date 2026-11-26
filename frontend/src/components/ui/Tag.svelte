<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { formatSequence } from '$lib/types'
  let {
    sequence,
    size = 'md',
    incomplete = false,
  }: { sequence: number; size?: 'sm' | 'md' | 'lg'; incomplete?: boolean } = $props()
</script>

<span
  class="tag {size}"
  class:incomplete
  aria-label={incomplete
    ? m.account_tag_incomplete({ sequence: formatSequence(sequence) })
    : formatSequence(sequence)}
  ><span class="tag-hole"></span>{formatSequence(sequence)}{#if incomplete}<span
      class="fold"
      aria-hidden="true"
    ></span>{/if}</span
>
