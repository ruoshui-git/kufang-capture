<script lang="ts">
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
  aria-label="{formatSequence(sequence)}{incomplete ? ', incomplete' : ''}"
  ><span class="tag-hole"></span>{formatSequence(sequence)}{#if incomplete}<span
      class="fold"
      aria-hidden="true"
    ></span>{/if}</span
>
