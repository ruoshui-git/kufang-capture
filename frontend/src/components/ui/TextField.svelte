<script lang="ts">
  let {
    label,
    value = $bindable(''),
    type = 'text',
    required = false,
    placeholder = '',
    name,
  }: {
    label: string
    value?: string
    type?: string
    required?: boolean
    placeholder?: string
    name?: string
  } = $props()
</script>

<label class="field"
  >{label}<input {name} {type} bind:value {required} {placeholder} autocomplete="off" /></label
>
