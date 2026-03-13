module uart_bridge (
    input wire clk,
    input wire rst,
    input wire enable,
    input wire [7:0] data_in,
    input wire serial_rx,
    output reg serial_tx,
    output reg busy,
    output reg [7:0] status
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            serial_tx <= 1'b1;
            busy <= 1'b0;
            status <= 8'd0;
        end else begin
            serial_tx <= data_in[0] ^ serial_rx;
            busy <= enable;
            status <= {7'd0, enable};
        end
    end
endmodule
