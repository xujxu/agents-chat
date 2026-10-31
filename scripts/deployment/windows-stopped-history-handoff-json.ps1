function Assert-AgentsChatStoppedHandoffJsonBinding(
    [Text.Json.JsonElement]$Actual, [Text.Json.JsonElement]$Expected
) {
    if ($Actual.ValueKind -ne $Expected.ValueKind) {
        throw 'Prepared handoff JSON binding differs: value kind.'
    }
    switch ($Expected.ValueKind) {
        ([Text.Json.JsonValueKind]::Object) {
            $fields = [Collections.Generic.Dictionary[string,Text.Json.JsonElement]]::new([StringComparer]::Ordinal)
            foreach ($field in $Expected.EnumerateObject()) {
                if (-not $fields.TryAdd($field.Name, $field.Value)) {
                    throw 'Prepared handoff JSON binding differs: duplicate reference key.'
                }
            }
            foreach ($field in $Actual.EnumerateObject()) {
                $value = [Text.Json.JsonElement]::new()
                if (-not $fields.Remove($field.Name, [ref]$value)) {
                    throw 'Prepared handoff JSON binding differs: unexpected or duplicate key.'
                }
                Assert-AgentsChatStoppedHandoffJsonBinding $field.Value $value
            }
            if ($fields.Count) { throw 'Prepared handoff JSON binding differs: missing key.' }
            return
        }
        ([Text.Json.JsonValueKind]::Array) {
            if ($Actual.GetArrayLength() -ne $Expected.GetArrayLength()) {
                throw 'Prepared handoff JSON binding differs: array length.'
            }
            for ($index = 0; $index -lt $Expected.GetArrayLength(); $index++) {
                Assert-AgentsChatStoppedHandoffJsonBinding $Actual[$index] $Expected[$index]
            }
            return
        }
        ([Text.Json.JsonValueKind]::String) {
            if ($Actual.GetString() -cne $Expected.GetString()) {
                throw 'Prepared handoff JSON binding differs: string.'
            }
            return
        }
        ([Text.Json.JsonValueKind]::Number) {
            if ($Actual.GetRawText() -cne $Expected.GetRawText()) {
                throw 'Prepared handoff JSON binding differs: number.'
            }
            return
        }
        ([Text.Json.JsonValueKind]::Null) { return }
        ([Text.Json.JsonValueKind]::True) { return }
        ([Text.Json.JsonValueKind]::False) { return }
        default { throw 'Prepared handoff JSON binding differs: unsupported value.' }
    }
}
