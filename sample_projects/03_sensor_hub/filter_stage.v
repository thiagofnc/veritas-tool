module filter_stage (
    input wire clk,
    input wire rst,
    input wire sample_valid,
    input wire [11:0] sample_data,
    output reg filt_valid,
    output reg [11:0] filt_data
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            filt_valid <= 1'b0;
            filt_data <= 12'd0;
        end else begin
            filt_valid <= sample_valid;
            filt_data <= sample_data >> 1;
        end
    end
endmodule
