<script lang="ts">
  import Menu from '../Menu.svelte'
  let { onpick, label = 'Entry actions' }: { onpick: () => void; label?: string | null } = $props()
</script>

<p>Outside the menu</p>
<Menu label={label ?? undefined}><button role="menuitem" onclick={onpick}>Delete entry</button></Menu>
