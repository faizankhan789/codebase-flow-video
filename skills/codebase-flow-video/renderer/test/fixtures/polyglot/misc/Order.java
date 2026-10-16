@RestController
public class OrderController {
    @PostMapping("/orders")
    public String create(String body) {
        if (body == null) { return "bad"; }
        return validate(body);
    }
    private String validate(String b) { return b; }
}
