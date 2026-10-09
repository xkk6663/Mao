$ErrorActionPreference = "Continue"
try {
  $shot = Invoke-RestMethod "http://127.0.0.1:8000/api/companion/screen-shot" -Method Post -ContentType "application/json" -Body '{}' -TimeoutSec 20
  "shot ok=$($shot.ok)"
  if ($shot.ok) {
    $body = @{ image_base64 = $shot.image_base64; question = "用调侃吐槽的语气，简短评价我屏幕上正在做的事。" } | ConvertTo-Json -Compress
    $vision = Invoke-RestMethod "http://127.0.0.1:8000/api/xiaozhi/vision" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 30
    "vision ok=$($vision.ok) text=$($vision.text.Substring(0, [Math]::Min(60, $vision.text.Length)))"
    $sayBody = @{ text = "你看看我的屏幕：" + $vision.text } | ConvertTo-Json -Compress
    $say = Invoke-RestMethod "http://127.0.0.1:8000/api/xiaozhi/say" -Method Post -ContentType "application/json" -Body $sayBody -TimeoutSec 10
    "say ok=$($say.ok)"
  }
} catch {
  "FAIL: $($_.Exception.Message)"
}
