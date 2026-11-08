<script lang="ts">
  import Menu from '../Menu.svelte'
  let { onpick }: { onpick: () => void } = $props()
</script>

<p>Outside the menu</p>
<Menu label="Entry actions"><button role="menuitem" onclick={onpick}>Delete entry</button></Menu>
