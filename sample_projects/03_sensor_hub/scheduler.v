module scheduler (
    input wire clk,
    input wire rst,
    input wire start,
    output reg route_uart,
    output reg route_spi,
    output reg busy
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            route_uart <= 1'b0;
            route_spi <= 1'b0;
            busy <= 1'b0;
        end else begin
            route_uart <= start;
            route_spi <= ~start;
            busy <= start;
        end
    end
endmodule
